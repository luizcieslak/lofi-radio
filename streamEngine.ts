import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Response } from 'express'
import { Mp3FrameReader, PreciseTimer } from './mp3parser'
import type { NowPlaying, Track } from './types'

class StreamEngine {
	private clients: Set<Response> = new Set()
	private sseClients: Set<Response> = new Set()
	private isRunning: boolean = false
	private nowPlaying: NowPlaying | null = null

	/**
	 * Add a new audio stream listener
	 */
	addClient(res: Response): void {
		// Set headers for streaming audio
		res.setHeader('Content-Type', 'audio/mpeg')
		res.setHeader('Cache-Control', 'no-cache, no-store')
		res.setHeader('Connection', 'keep-alive')
		res.setHeader('Transfer-Encoding', 'chunked')
		res.setHeader('Access-Control-Allow-Origin', '*')
		// Prevent buffering in nginx/proxies
		res.setHeader('X-Accel-Buffering', 'no')

		this.clients.add(res)
		console.log(`[Stream] Client connected. Total: ${this.clients.size}`)

		// Remove client when they disconnect
		res.on('close', () => {
			this.clients.delete(res)
			console.log(`[Stream] Client disconnected. Total: ${this.clients.size}`)
		})

		res.on('error', err => {
			console.error('[Stream] Client error:', err.message)
			this.clients.delete(res)
		})
	}

	/**
	 * Add a Server-Sent Events listener for metadata updates
	 */
	addSSEClient(res: Response): void {
		res.setHeader('Content-Type', 'text/event-stream')
		res.setHeader('Cache-Control', 'no-cache')
		res.setHeader('Connection', 'keep-alive')
		res.setHeader('Access-Control-Allow-Origin', '*')

		this.sseClients.add(res)
		console.log(`[SSE] Client connected. Total: ${this.sseClients.size}`)

		// Send current track immediately
		if (this.nowPlaying) {
			res.write(`data: ${JSON.stringify(this.nowPlaying)}\n\n`)
		}

		// Heartbeat to keep connection alive
		const heartbeat = setInterval(() => {
			if (!res.writableEnded) {
				res.write(': heartbeat\n\n')
			}
		}, 30000)

		res.on('close', () => {
			clearInterval(heartbeat)
			this.sseClients.delete(res)
			console.log(`[SSE] Client disconnected. Total: ${this.sseClients.size}`)
		})
	}

	/**
	 * Broadcast audio data to all connected stream clients
	 */
	private broadcast(data: Buffer): void {
		for (const client of this.clients) {
			try {
				if (!client.writableEnded) {
					client.write(data)
				} else {
					this.clients.delete(client)
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

		const data = JSON.stringify(this.nowPlaying)

		for (const client of this.sseClients) {
			try {
				if (!client.writableEnded) {
					client.write(`data: ${data}\n\n`)
				} else {
					this.sseClients.delete(client)
				}
			} catch (err) {
				console.error('[SSE] Broadcast error:', err)
				this.sseClients.delete(client)
			}
		}
	}

	/**
	 * Stream a single track to all listeners
	 */
	private async streamTrack(track: Track): Promise<void> {
		console.log(`[Engine] Now playing: ${track.artist} - ${track.title}`)

		// Update now playing and notify SSE clients
		this.nowPlaying = {
			track,
			startedAt: Date.now(),
		}
		this.broadcastMetadata()

		const reader = new Mp3FrameReader(track.path)
		const timer = new PreciseTimer()

		let frameCount = 0
		let frame = reader.readNextFrame()

		while (frame && this.isRunning) {
			// Send frame to all clients
			this.broadcast(frame.data)

			// Add frame duration to our time budget
			timer.addTime(frame.header.frameDurationMs)

			// Wait until it's time for the next frame
			await timer.wait()

			// Read next frame
			frame = reader.readNextFrame()
			frameCount++

			// Log progress every ~30 seconds (assuming ~26ms per frame)
			if (frameCount % 1150 === 0) {
				console.log(
					`[Engine] Progress: ${Math.round((frameCount * 26) / 1000)}s, ` + `${this.clients.size} listeners`,
				)
			}
		}

		reader.close()
		console.log(`[Engine] Finished: ${track.title} (${frameCount} frames)`)
	}

	/**
	 * Start the streaming engine with a track provider function
	 */
	async start(getNextTrack: () => Promise<Track | undefined>): Promise<void> {
		this.isRunning = true
		console.log('[Engine] Started')

		while (this.isRunning) {
			const track = await getNextTrack()

			if (!track) {
				console.log('[Engine] No tracks available, waiting 5s...')
				await new Promise(resolve => setTimeout(resolve, 5000))
				continue
			}

			// Check if file exists
			if (!fs.existsSync(track.path)) {
				console.error(`[Engine] File not found: ${track.path}`)
				continue
			}

			try {
				await this.streamTrack(track)
			} catch (err) {
				console.error('[Engine] Error streaming track:', err)
				// Wait a bit before trying next track
				await new Promise(resolve => setTimeout(resolve, 1000))
			}
		}
	}

	stop(): void {
		this.isRunning = false
		console.log('[Engine] Stopped')
	}

	getNowPlaying(): NowPlaying | null {
		return this.nowPlaying
	}

	getStatus() {
		return {
			isRunning: this.isRunning,
			listenerCount: this.clients.size,
			sseClientCount: this.sseClients.size,
			nowPlaying: this.nowPlaying,
		}
	}
}

export { StreamEngine }
