import * as fs from 'node:fs'
import type { Response } from 'express'
import { Mp3FrameReader, PreciseTimer } from './mp3parser'
import type { NowPlaying, Track } from './types'

interface StreamSession {
	res: Response
	connectedAt: number
	lastSeenAt: number
	heartbeatEnabled: boolean
}

// `stalledSince`: timestamp the socket last backpressured and hasn't drained
// since (0 = healthy). A persistently stalled socket gets reaped.
interface ClientMeta {
	stalledSince: number
	sessionId: string | null
}

// SSE clients get the same backpressure/liveness tracking as audio clients so
// the reaper can collect silently-dropped sockets (which never emit 'close').
//
// `lastSeenAt` powers the real backstop: a silently-dropped SSE socket (peer
// vanished with no FIN) never trips `stalledSince` because SSE writes are tiny
// and infrequent, and OS keepalive takes ~11 min to notice. So the client sends
// a periodic app-level heartbeat that bumps `lastSeenAt`; the reaper expires any
// SSE session that hasn't been refreshed within SSE_HEARTBEAT_TTL_MS. Sessions
// with no id (`sseSessionId === null`, e.g. a raw curl) skip TTL expiry and rely
// on the stall/dead checks only.
export interface SSEClientMeta {
	stalledSince: number
	heartbeat: ReturnType<typeof setInterval>
	sseSessionId: string | null
	lastSeenAt: number
}

/**
 * A stream/SSE connection is reapable when it's dead (ended/destroyed) or has
 * been backpressured (unwritable) longer than the stall timeout. Shared by the
 * audio and SSE sweeps (and PlaylistManager's SSE sweep) so the liveness
 * predicate stays in one place.
 */
export function isReapable(
	res: Response,
	{ stalledSince, now, stallTimeoutMs }: { stalledSince: number; now: number; stallTimeoutMs: number },
): boolean {
	const dead = res.writableEnded || res.destroyed
	const stalledTooLong = stalledSince !== 0 && now - stalledSince > stallTimeoutMs
	return dead || stalledTooLong
}

/** Session ids are client-supplied and used in logs/map keys, so validate shape. */
export function isValidSessionId(sessionId: string): boolean {
	return /^[A-Za-z0-9_-]{8,128}$/.test(sessionId)
}

/**
 * An SSE client is reapable when it's dead/stalled (isReapable) OR — the real
 * backstop — it has a session id and hasn't heartbeated within the TTL. The
 * heartbeat check is what actually collects silently-dropped SSE sockets, since
 * their tiny/infrequent writes never trip the stall check and OS keepalive is
 * ~11 min. Id-less clients (raw curl) fall back to the stall/dead checks only.
 * Shared by the StreamEngine and PlaylistManager SSE sweeps.
 */
export function isSSEReapable(
	res: Response,
	meta: SSEClientMeta,
	{ now, stallTimeoutMs, heartbeatTtlMs }: { now: number; stallTimeoutMs: number; heartbeatTtlMs: number },
): boolean {
	if (isReapable(res, { stalledSince: meta.stalledSince, now, stallTimeoutMs })) return true
	return meta.sseSessionId !== null && now - meta.lastSeenAt > heartbeatTtlMs
}

/**
 * Write a payload to one SSE client with backpressure tracking: skip dead/stalled
 * sockets, and on a full send-buffer mark the client stalled + clear it on 'drain'
 * (a socket that never drains is collected by a reaper). Shared by StreamEngine
 * and PlaylistManager. Returns false if the write was skipped.
 */
export function writeSSEClient(
	client: Response,
	meta: SSEClientMeta,
	payload: string,
	logPrefix: string,
): boolean {
	if (client.writableEnded || meta.stalledSince !== 0) return false
	try {
		if (!client.write(payload)) {
			meta.stalledSince = Date.now()
			client.once('drain', () => {
				meta.stalledSince = 0
			})
		}
		return true
	} catch (err) {
		console.error(`${logPrefix} Write error:`, err instanceof Error ? err.message : String(err))
		return false
	}
}

/**
 * Close any existing SSE connection for the same session id before registering a
 * new one. Without this, a client that reconnects its EventSource (tab focus,
 * network blip) with the same `sid` leaves the old Response orphaned in the map —
 * and since the client's heartbeat refreshes `lastSeenAt` on EVERY entry matching
 * the sid, those orphans look perpetually alive and the TTL reaper never collects
 * them. Mirrors the same-session dedup the audio /stream path already does.
 * Destroy() fires 'close', which runs the per-client cleanup (clears the heartbeat
 * interval + deletes from the map).
 */
export function dedupeSSESession(sseClients: Map<Response, SSEClientMeta>, sessionId: string): void {
	for (const [client, meta] of sseClients) {
		if (meta.sseSessionId === sessionId) {
			sseClients.delete(client)
			client.destroy()
		}
	}
}

interface PreloadedTrack {
	track: Track
	reader: Mp3FrameReader
	firstFrame: ReturnType<Mp3FrameReader['readNextFrame']>
	preparedAt: number
}

interface StreamTrackResult {
	nextPreloaded: PreloadedTrack | null
}

class StreamEngine {
	private clients: Map<Response, ClientMeta> = new Map() // raw stream connection -> liveness
	private sessions: Map<string, StreamSession> = new Map() // sessionId -> session
	private sseClients: Map<Response, SSEClientMeta> = new Map()
	private isRunning: boolean = false
	private skipRequested: boolean = false
	private nowPlaying: NowPlaying | null = null

	// Silently-dropped sockets never emit 'close', so reap them actively to avoid
	// leaking buffers/FDs and inflating the listener count.
	private reaperInterval: ReturnType<typeof setInterval> | null = null
	private readonly REAPER_INTERVAL_MS = 15_000
	private readonly STALL_TIMEOUT_MS = 45_000
	private readonly HEARTBEAT_TTL_MS = 150_000
	// SSE clients heartbeat on their own cadence (independent of the audio stream
	// session, since the metadata SSE is open even before the user presses play).
	private readonly SSE_HEARTBEAT_TTL_MS = 150_000

	// Burst-on-connect: ring buffer of the most recently broadcast frames. A new
	// client joins at the razor-thin live edge, so its browser buffer hovers near
	// empty and underruns on any jitter -> ~80ms audible "chops". Replaying this
	// backlog on connect gives the browser an immediate playback cushion that
	// absorbs jitter. ~128KB ≈ 3-4s at typical bitrates.
	// Trade-off: a new listener starts ~burst behind the live edge, so sync
	// *between* listeners is approximate (fine for radio; nobody A/Bs two devices).
	private burstChunks: Buffer[] = []
	private burstBytes = 0
	private readonly BURST_LIMIT_BYTES = 128 * 1024

	/**
	 * Add a new audio stream listener
	 * @param sessionId - Unique session ID from client (for deduplication)
	 */
	addClient(res: Response, sessionId?: string, heartbeatEnabled = false): void {
		const validSessionId = sessionId && this.isValidSessionId(sessionId) ? sessionId : null
		const now = Date.now()

		// Set headers for streaming audio
		res.setHeader('Content-Type', 'audio/mpeg')
		res.setHeader('Cache-Control', 'no-cache, no-store')
		res.setHeader('Connection', 'keep-alive')
		res.setHeader('Transfer-Encoding', 'chunked')
		res.setHeader('Access-Control-Allow-Origin', '*')
		// Prevent buffering in nginx/proxies
		res.setHeader('X-Accel-Buffering', 'no')

		// OS-level backstop for peers that vanished without a FIN; the reaper
		// catches them sooner.
		res.socket?.setKeepAlive(true, 30_000)

		// Burst-on-connect: replay the recent frame backlog so the browser builds a
		// playback cushion immediately instead of underrunning at the live edge.
		// Written synchronously before joining the live set so it can't interleave
		// with a live frame (addClient has no await, so broadcast() can't run mid-way).
		if (this.burstBytes > 0) {
			try {
				res.write(Buffer.concat(this.burstChunks, this.burstBytes))
			} catch (err) {
				// Client may have already disconnected; the close handler cleans up.
				console.error('[Stream] Burst write failed:', (err as Error).message)
			}
		}

		this.clients.set(res, { stalledSince: 0, sessionId: validSessionId })

		// Track by session ID if provided (for accurate listener count)
		if (validSessionId) {
			const existing = this.sessions.get(validSessionId)
			if (existing) {
				// Same session reconnecting - close old connection
				try {
					existing.res.end()
				} catch (e) {
					// Ignore errors closing old connection
				}
				this.clients.delete(existing.res)
			}
			this.sessions.set(validSessionId, {
				res,
				connectedAt: existing?.connectedAt ?? now,
				lastSeenAt: now,
				heartbeatEnabled: heartbeatEnabled || existing?.heartbeatEnabled || false,
			})
			console.log(
				`[Stream] Session ${validSessionId.slice(0, 8)}... connected. Unique listeners: ${this.getListenerCount()}`,
			)
		} else {
			console.log(`[Stream] Anonymous client connected. Total connections: ${this.clients.size}`)
		}

		// Remove client when they disconnect
		res.on('close', () => {
			this.clients.delete(res)
			if (validSessionId) {
				const session = this.sessions.get(validSessionId)
				if (session?.res === res) {
					this.sessions.delete(validSessionId)
					console.log(
						`[Stream] Session ${validSessionId.slice(0, 8)}... disconnected. Unique listeners: ${this.getListenerCount()}`,
					)
				}
			}
		})

		res.on('error', err => {
			console.error('[Stream] Client error:', err.message)
			this.clients.delete(res)
			if (validSessionId) {
				const session = this.sessions.get(validSessionId)
				if (session?.res === res) {
					this.sessions.delete(validSessionId)
				}
			}
		})
	}

	refreshSession(sessionId: string): boolean {
		if (!this.isValidSessionId(sessionId)) return false

		const session = this.sessions.get(sessionId)
		if (!session?.heartbeatEnabled) return false

		session.lastSeenAt = Date.now()
		return true
	}

	endSession(sessionId: string): boolean {
		if (!this.isValidSessionId(sessionId)) return false

		const session = this.sessions.get(sessionId)
		if (!session?.heartbeatEnabled) return false

		this.sessions.delete(sessionId)
		this.clients.delete(session.res)
		session.res.destroy()
		return true
	}

	private isValidSessionId(sessionId: string): boolean {
		return isValidSessionId(sessionId)
	}

	/** Start the periodic sweep that destroys dead/stalled stream connections. */
	private startReaper(): void {
		if (this.reaperInterval) return
		this.reaperInterval = setInterval(() => this.reapStalledClients(), this.REAPER_INTERVAL_MS)
	}

	/**
	 * Destroy connections that are dead or stalled past STALL_TIMEOUT_MS.
	 * destroy() emits 'close', so the addClient cleanup (clients + sessions) runs.
	 */
	private reapStalledClients(): void {
		const now = Date.now()
		let reaped = 0
		for (const [client, meta] of this.clients) {
			if (
				isReapable(client, { stalledSince: meta.stalledSince, now, stallTimeoutMs: this.STALL_TIMEOUT_MS })
			) {
				client.destroy()
				this.clients.delete(client)
				if (meta.sessionId) {
					const session = this.sessions.get(meta.sessionId)
					if (session?.res === client) {
						this.sessions.delete(meta.sessionId)
					}
				}
				reaped++
			}
		}
		const sseReaped = this.reapStalledSSEClients(now)
		const expired = this.expireHeartbeatSessions(now)
		if (reaped > 0) {
			console.log(
				`[Stream] Reaped ${reaped} dead/stalled connection(s). ` +
					`Unique listeners: ${this.getListenerCount()}, raw connections: ${this.clients.size}`,
			)
		}
		if (sseReaped > 0) {
			console.log(`[SSE] Reaped ${sseReaped} dead/stalled connection(s). Total: ${this.sseClients.size}`)
		}
		if (expired > 0) {
			console.log(
				`[Stream] Expired ${expired} stale heartbeat session(s). ` +
					`Unique listeners: ${this.getListenerCount()}, raw connections: ${this.clients.size}`,
			)
		}
	}

	/**
	 * Destroy SSE connections that are dead, stalled past STALL_TIMEOUT_MS, or
	 * (for sessions with an id) haven't heartbeated within SSE_HEARTBEAT_TTL_MS.
	 * destroy() emits 'close', so the addSSEClient cleanup (clears the heartbeat
	 * interval + deletes from the map) runs. The heartbeat-TTL check is the real
	 * backstop: silently-dropped SSE sockets never trip stall/dead (writes are
	 * tiny + OS keepalive is ~11 min), but a missed client heartbeat expires them.
	 */
	private reapStalledSSEClients(now: number): number {
		let reaped = 0
		for (const [client, meta] of this.sseClients) {
			if (
				isSSEReapable(client, meta, {
					now,
					stallTimeoutMs: this.STALL_TIMEOUT_MS,
					heartbeatTtlMs: this.SSE_HEARTBEAT_TTL_MS,
				})
			) {
				client.destroy()
				this.sseClients.delete(client)
				reaped++
			}
		}
		return reaped
	}

	/** Refresh an SSE session's liveness (called by the client heartbeat). */
	refreshSSESession(sessionId: string): boolean {
		if (!this.isValidSessionId(sessionId)) return false
		let refreshed = false
		const now = Date.now()
		for (const meta of this.sseClients.values()) {
			if (meta.sseSessionId === sessionId) {
				meta.lastSeenAt = now
				refreshed = true
			}
		}
		return refreshed
	}

	private expireHeartbeatSessions(now: number): number {
		let expired = 0
		for (const [sessionId, session] of this.sessions) {
			if (!session.heartbeatEnabled || now - session.lastSeenAt <= this.HEARTBEAT_TTL_MS) continue

			this.sessions.delete(sessionId)
			this.clients.delete(session.res)
			session.res.destroy()
			expired++
		}
		return expired
	}

	/**
	 * Add a Server-Sent Events listener for metadata updates
	 */
	addSSEClient(res: Response, sessionId?: string): void {
		res.setHeader('Content-Type', 'text/event-stream')
		res.setHeader('Cache-Control', 'no-cache')
		res.setHeader('Connection', 'keep-alive')
		res.setHeader('Access-Control-Allow-Origin', '*')

		// OS-level backstop for peers that vanished without a FIN; the reaper
		// catches them sooner. Mirrors the audio /stream path.
		res.socket?.setKeepAlive(true, 30_000)

		// Heartbeat keeps the connection alive; guarded like every SSE write so it
		// never writes into a stalled/dead socket the reaper is about to collect.
		const heartbeat = setInterval(() => {
			const current = this.sseClients.get(res)
			if (current) this.writeSSE(res, current, ': heartbeat\n\n')
		}, 30000)

		const sseSessionId = sessionId && this.isValidSessionId(sessionId) ? sessionId : null
		// Close any prior connection for this session so reconnects don't leak
		// orphaned entries that the shared heartbeat keeps falsely alive.
		if (sseSessionId) dedupeSSESession(this.sseClients, sseSessionId)
		const meta: SSEClientMeta = { stalledSince: 0, heartbeat, sseSessionId, lastSeenAt: Date.now() }
		this.sseClients.set(res, meta)
		console.log(`[SSE] Client connected. Total: ${this.sseClients.size}`)

		// Send current track immediately
		if (this.nowPlaying) {
			this.writeSSE(res, meta, `data: ${JSON.stringify(this.nowPlaying)}\n\n`)
		}

		res.on('close', () => {
			clearInterval(heartbeat)
			this.sseClients.delete(res)
			console.log(`[SSE] Client disconnected. Total: ${this.sseClients.size}`)
		})
	}

	private writeSSE(client: Response, meta: SSEClientMeta, payload: string): boolean {
		return writeSSEClient(client, meta, payload, '[SSE]')
	}

	/**
	 * Append a frame to the burst-on-connect ring buffer, trimming the oldest
	 * frames once we exceed the byte cap. Frames are whole MP3 frames (the parser
	 * allocates a fresh Buffer per frame), so the backlog is always frame-aligned.
	 */
	private appendToBurst(data: Buffer): void {
		this.burstChunks.push(data)
		this.burstBytes += data.length
		while (this.burstBytes > this.BURST_LIMIT_BYTES && this.burstChunks.length > 1) {
			const removed = this.burstChunks.shift()
			if (removed) this.burstBytes -= removed.length
		}
	}

	/**
	 * Broadcast audio data to all connected stream clients
	 */
	private broadcast(data: Buffer): void {
		// Record into the burst backlog first so even a zero-listener stream keeps
		// a warm cushion ready for the next client to connect.
		this.appendToBurst(data)

		for (const [client, meta] of this.clients) {
			if (client.writableEnded) {
				this.clients.delete(client)
				continue
			}
			// Backpressured: skip rather than grow an unbounded buffer. Resumes on
			// 'drain', or the reaper destroys it once the stall outlasts the timeout.
			if (meta.stalledSince !== 0) {
				continue
			}
			try {
				if (!client.write(data)) {
					const stalledAt = Date.now()
					meta.stalledSince = stalledAt
					// Diagnostic only (no behavior change): confirm whether browser
					// read-pauses are backpressuring clients and for how long.
					const who = meta.sessionId ? `${meta.sessionId.slice(0, 8)}...` : 'anonymous'
					console.warn(`[Stream] Client ${who} backpressured (send buffer full)`)
					client.once('drain', () => {
						console.log(`[Stream] Client ${who} drained after ${Date.now() - stalledAt}ms stalled`)
						meta.stalledSince = 0
					})
				}
			} catch (err) {
				console.error('[Stream] Broadcast error:', err)
				this.clients.delete(client)
			}
		}
	}

	/**
	 * Broadcast metadata update to all SSE clients
	 */
	private broadcastMetadata(): void {
		if (!this.nowPlaying) return

		const payload = `data: ${JSON.stringify(this.nowPlaying)}\n\n`

		for (const [client, meta] of this.sseClients) {
			if (client.writableEnded) {
				this.sseClients.delete(client)
				continue
			}
			this.writeSSE(client, meta, payload)
		}
	}

	private prepareTrack(track: Track): PreloadedTrack | null {
		const preparedAt = Date.now()
		const reader = new Mp3FrameReader(track.path)
		const firstFrame = reader.readNextFrame()

		if (!firstFrame) {
			reader.close()
			console.warn(`[Engine] Could not preload track (no frames): ${track.title}`)
			return null
		}

		return {
			track,
			reader,
			firstFrame,
			preparedAt,
		}
	}

	private closePreloadedTrack(preloaded: PreloadedTrack | null): void {
		if (!preloaded) return
		preloaded.reader.close()
	}

	private async preloadFromPeek(
		peekNextTrack: () => Promise<Track | undefined>,
	): Promise<PreloadedTrack | null> {
		const startedAt = Date.now()
		const nextTrack = await peekNextTrack()
		if (!nextTrack) return null

		if (!fs.existsSync(nextTrack.path)) {
			console.error(`[Engine] File not found while preloading: ${nextTrack.path}`)
			return null
		}

		const preloaded = this.prepareTrack(nextTrack)
		if (preloaded) {
			console.log(`[Engine] Preloaded next track in ${Date.now() - startedAt}ms: ${nextTrack.title}`)
		}
		return preloaded
	}

	/**
	 * Stream a single track to all listeners.
	 *
	 * Handoff strategy: when the last frame is read, we commit the preloaded
	 * track (after verifying it still matches `peekNextTrack()`) BEFORE the
	 * final `timer.wait()`. That overlaps the commit work (SSE broadcast,
	 * fire-and-forget state save) with the ~26ms wait for the last frame,
	 * so by the time we return, the next track is ready to broadcast its
	 * already-loaded first frame with near-zero gap.
	 */
	private async streamTrack(
		current: PreloadedTrack,
		peekNextTrack: () => Promise<Track | undefined>,
		commitNextTrack: (track: Track) => Promise<Track | undefined>,
	): Promise<StreamTrackResult> {
		const trackStartTs = Date.now()
		console.log(`[Engine] Now playing: ${current.track.artist} - ${current.track.title}`)
		console.log(
			`[Engine] Track preload ready in ${trackStartTs - current.preparedAt}ms for: ${current.track.title}`,
		)

		this.skipRequested = false

		this.nowPlaying = {
			track: current.track,
			startedAt: trackStartTs,
		}
		this.broadcastMetadata()

		const timer = new PreciseTimer()
		const reader = current.reader

		let frameCount = 0
		let wasSkipped = false
		let frame = current.firstFrame
		let nextPreloaded: PreloadedTrack | null = null
		let committed = false
		let boundaryMarkedAt: number | null = null

		while (frame && this.isRunning && !this.skipRequested) {
			this.broadcast(frame.data)
			timer.addTime(frame.header.frameDurationMs)

			const nextFrame = reader.readNextFrame()
			frameCount++

			// Trigger preload once around 500 frames in (~13s). Done before EOF
			// so the file read + ID3 skip + first-frame parse is off the hot path.
			if (!nextPreloaded && frameCount === 500) {
				nextPreloaded = await this.preloadFromPeek(peekNextTrack)
			}

			// EOF detected. Do the handoff work now, before the final wait().
			// The next track's first frame is already in memory (preloaded), so
			// after this block the only gap is "exit loop → re-enter streamTrack
			// → broadcast first frame", which is sub-millisecond.
			if (!nextFrame && !committed) {
				boundaryMarkedAt = Date.now()
				console.log(`[Engine] Boundary reached for ${current.track.title} after ${frameCount} frames`)

				if (nextPreloaded) {
					const fresh = await peekNextTrack()
					if (fresh && fresh.id === nextPreloaded.track.id) {
						const result = await commitNextTrack(nextPreloaded.track)
						if (result) {
							committed = true
							console.log(`[Engine] Committed handoff in ${Date.now() - boundaryMarkedAt}ms: ${result.title}`)
						} else {
							console.warn('[Engine] commitNextTrack returned undefined during handoff')
							this.closePreloadedTrack(nextPreloaded)
							nextPreloaded = null
						}
					} else {
						console.warn(
							`[Engine] Preloaded track stale (expected ${nextPreloaded.track.title}, peek now ${fresh?.title ?? 'none'}); discarding`,
						)
						this.closePreloadedTrack(nextPreloaded)
						nextPreloaded = null
					}
				}
			}

			await timer.wait()
			frame = nextFrame

			if (frameCount % 1150 === 0) {
				console.log(
					`[Engine] Progress: ${Math.round((frameCount * 26) / 1000)}s, ` +
						`${this.sessions.size} listeners (${this.clients.size} raw connections)`,
				)
			}
		}

		if (boundaryMarkedAt) {
			console.log(
				`[Engine] Track ended for ${current.track.title}; handoff gap so far ${Date.now() - boundaryMarkedAt}ms`,
			)
		}

		if (this.skipRequested) {
			wasSkipped = true
			this.skipRequested = false
			console.log(`[Engine] Skipped: ${current.track.title} (at frame ${frameCount})`)
		}

		reader.close()

		if (!wasSkipped) {
			console.log(`[Engine] Finished: ${current.track.title} (${frameCount} frames)`)
		}

		// On skip, the preloaded track is no longer guaranteed to match the
		// playlist's current head — throw it away and let the outer loop fetch fresh.
		if (wasSkipped && nextPreloaded) {
			this.closePreloadedTrack(nextPreloaded)
			return { nextPreloaded: null }
		}

		return { nextPreloaded: committed ? nextPreloaded : null }
	}

	/**
	 * Start the streaming engine with a track provider function
	 */
	async start(
		peekNextTrack: () => Promise<Track | undefined>,
		commitNextTrack: (track: Track) => Promise<Track | undefined>,
	): Promise<void> {
		this.isRunning = true
		this.startReaper()
		console.log('[Engine] Started')

		let currentPreloaded: PreloadedTrack | null = null

		while (this.isRunning) {
			if (!currentPreloaded) {
				const nextTrack = await peekNextTrack()

				if (!nextTrack) {
					console.log('[Engine] No tracks available, waiting 5s...')
					await new Promise(resolve => setTimeout(resolve, 5000))
					continue
				}

				const committedTrack = await commitNextTrack(nextTrack)
				if (!committedTrack) {
					continue
				}

				if (!fs.existsSync(committedTrack.path)) {
					console.error(`[Engine] File not found: ${committedTrack.path}`)
					continue
				}

				currentPreloaded = this.prepareTrack(committedTrack)
				if (!currentPreloaded) {
					continue
				}
			}

			try {
				const result = await this.streamTrack(currentPreloaded, peekNextTrack, commitNextTrack)
				// streamTrack has already committed the next track (with stale-check)
				// before returning it, so currentPreloaded is either ready to play
				// immediately or null (forcing a fresh peek+commit+prepare next iteration).
				currentPreloaded = result.nextPreloaded
			} catch (err) {
				console.error('[Engine] Error streaming track:', err)
				this.closePreloadedTrack(currentPreloaded)
				currentPreloaded = null
				await new Promise(resolve => setTimeout(resolve, 1000))
			}
		}

		this.closePreloadedTrack(currentPreloaded)
	}

	stop(): void {
		this.isRunning = false
		if (this.reaperInterval) {
			clearInterval(this.reaperInterval)
			this.reaperInterval = null
		}
		console.log('[Engine] Stopped')
	}

	/**
	 * Skip the currently playing track
	 * Called when the current track is deleted from the playlist
	 */
	skipCurrentTrack(): void {
		console.log('[Engine] Skip requested for current track')
		this.skipRequested = true
	}

	getNowPlaying(): NowPlaying | null {
		return this.nowPlaying
	}

	getStatus() {
		return {
			isRunning: this.isRunning,
			listenerCount: this.getListenerCount(),
			sseClientCount: this.sseClients.size,
			nowPlaying: this.nowPlaying,
		}
	}

	private getListenerCount(): number {
		let anonymousCount = 0
		for (const meta of this.clients.values()) {
			if (!meta.sessionId) anonymousCount++
		}
		return this.sessions.size + anonymousCount
	}
}

export { StreamEngine }
