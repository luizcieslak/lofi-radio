/**
 * EXPRESS RADIO STREAMING SERVER
 * ==============================
 *
 * A complete, working radio server using Express.
 * Streams MP3 files to multiple listeners in sync with live metadata updates.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { normalizeInPlace } from './audioNormalizer'
import { validateClips } from './clipValidation'
import { metadataManager } from './metadataManager'
import { playlistManager } from './playlistManager'
import { StreamEngine } from './streamEngine'

// ============================================================================
// EXPRESS SERVER
// ============================================================================

const app = express()
const engine = new StreamEngine()

// Connect the skip callback so deleted tracks can trigger skip
playlistManager.setSkipCallback(() => {
	engine.skipCurrentTrack()
})

// ============================================================================
// FILE UPLOAD CONFIGURATION
// ============================================================================

const SONGS_DIR = path.join(__dirname, '../songs')

// Ensure songs directory exists
if (!fs.existsSync(SONGS_DIR)) {
	fs.mkdirSync(SONGS_DIR, { recursive: true })
}

// Configure multer for file uploads
const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		cb(null, SONGS_DIR)
	},
	filename: (req, file, cb) => {
		// Fix UTF-8 double-encoding issue: multer interprets UTF-8 bytes as Latin-1
		// Convert back to proper UTF-8
		let filename = file.originalname
		try {
			// If the filename contains high bytes, it's likely mis-decoded UTF-8
			if (/[\u0080-\u00ff]/.test(filename)) {
				// Re-encode as Latin-1 bytes, then decode as UTF-8
				const latin1Bytes = Buffer.from(filename, 'latin1')
				filename = latin1Bytes.toString('utf8')
			}
		} catch (err) {
			// If conversion fails, keep original
			console.warn('Failed to fix filename encoding:', err)
		}
		cb(null, filename)
	},
})

const upload = multer({
	storage,
	limits: {
		fileSize: 50 * 1024 * 1024, // 50MB per file
	},
	fileFilter: (req, file, cb) => {
		// Only accept MP3 files
		if (file.mimetype === 'audio/mpeg' || file.originalname.endsWith('.mp3')) {
			cb(null, true)
		} else {
			cb(null, false) // Gracefully reject instead of throwing
		}
	},
})

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(express.json())

// CORS middleware
app.use((req: Request, res: Response, next: NextFunction) => {
	res.setHeader('Access-Control-Allow-Origin', '*')
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE')
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key')
	if (req.method === 'OPTIONS') {
		res.sendStatus(200)
		return
	}
	next()
})

// Authentication middleware for admin routes
const requireAuth = (req: Request, res: Response, next: NextFunction) => {
	const apiKey = req.headers['x-api-key'] as string
	const expectedKey = process.env.RADIO_API_KEY

	if (!expectedKey) {
		res.status(500).json({
			error: 'Server misconfiguration',
			message: 'RADIO_API_KEY environment variable not set',
		})
		return
	}

	if (!apiKey || apiKey !== expectedKey) {
		res.status(401).json({
			error: 'Unauthorized',
			message: 'Invalid or missing API key',
		})
		return
	}

	next()
}

const getQueryParam = (value: unknown): string | undefined => {
	return typeof value === 'string' ? value : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main audio stream endpoint
 * Connect with: <audio src="http://localhost:3000/stream">
 */
app.get('/stream', (req: Request, res: Response) => {
	// Session ID for unique listener tracking (sent by client)
	const sessionId = getQueryParam(req.query.sid)
	const heartbeatEnabled = getQueryParam(req.query.hb) === '1'
	engine.addClient(res, sessionId, heartbeatEnabled)
	// Note: we don't call res.end() - the response stays open
})

/**
 * Get current track info (JSON)
 */
app.get('/now-playing', (req: Request, res: Response) => {
	const nowPlaying = engine.getNowPlaying()
	if (!nowPlaying) {
		res.json({ track: null })
		return
	}
	// Playback position rides along so the DJ scrub bar has a source of truth
	// without polling a second endpoint.
	res.json({ ...nowPlaying, ...engine.getPlayback() })
})

/**
 * Server-Sent Events for live metadata updates
 * Connect with: new EventSource("/now-playing/events")
 */
app.get('/now-playing/events', (req: Request, res: Response) => {
	engine.addSSEClient(res, getQueryParam(req.query.sid))
})

/**
 * Server status
 */
app.get('/status', (req: Request, res: Response) => {
	res.json(engine.getStatus())
})

app.post('/api/listeners/heartbeat', (req: Request, res: Response) => {
	const sessionId = getQueryParam(req.query.sid)
	if (!sessionId) {
		res.sendStatus(204)
		return
	}

	engine.refreshSession(sessionId)
	res.sendStatus(204)
})

app.post('/api/listeners/end', (req: Request, res: Response) => {
	const sessionId = getQueryParam(req.query.sid)
	if (sessionId) {
		engine.endSession(sessionId)
	}
	res.sendStatus(204)
})

// SSE liveness heartbeat. The metadata/playlist SSE streams are open even before
// the user presses play, so they need their own heartbeat (separate from the
// audio-stream listener heartbeat above). A missed heartbeat lets the reaper
// expire silently-dropped SSE sockets that no other check can detect.
app.post('/api/sse/heartbeat', (req: Request, res: Response) => {
	const sessionId = getQueryParam(req.query.sid)
	if (sessionId) {
		engine.refreshSSESession(sessionId)
		playlistManager.refreshSSESession(sessionId)
	}
	res.sendStatus(204)
})

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES (authenticated)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upload single song
 * POST /admin/upload
 * Headers: X-API-Key: <your-api-key>
 * Body: multipart/form-data with 'song' field
 */
app.post('/admin/upload', requireAuth, upload.single('song'), async (req: Request, res: Response) => {
	if (!req.file) {
		res.status(400).json({ error: 'No file uploaded' })
		return
	}

	// Normalize to the canonical format + loudness BEFORE extracting metadata, so
	// heterogeneous sample rates can't cause a midstream decode error at track
	// boundaries and tracks don't jump in volume. On failure the original file is
	// kept (upload is never lost). Metadata is read from the final (possibly
	// re-encoded) file so duration stays accurate.
	const norm = await normalizeInPlace(req.file.path)
	if (norm.status === 'failed') {
		console.warn(`[Upload] Normalization skipped for ${req.file.filename}: ${norm.error}`)
	}

	// Extract ID3 metadata and store
	const metadata = await metadataManager.processUpload(req.file.filename, req.file.path)

	// Add track to playlist dynamically (no full rescan needed)
	playlistManager.addTrack(req.file.filename)

	res.json({
		success: true,
		filename: req.file.filename,
		size: req.file.size,
		normalized: norm.status === 'normalized',
		sourceSampleRate: norm.sourceSampleRate,
		sourceLoudnessLufs: norm.status === 'failed' ? null : norm.sourceLoudnessLufs,
		metadata: {
			title: metadata.title,
			artist: metadata.artist,
			album: metadata.album,
			durationMs: metadata.durationMs,
			extractedFromId3: metadata.extractedFromId3,
		},
		message: 'Song uploaded successfully',
	})
})

/**
 * Upload multiple songs
 * POST /admin/upload/batch
 * Headers: X-API-Key: <your-api-key>
 * Body: multipart/form-data with 'songs[]' field (multiple files)
 */
app.post(
	'/admin/upload/batch',
	requireAuth,
	upload.array('songs', 100),
	async (req: Request, res: Response) => {
		const files = req.files as Express.Multer.File[]

		if (!files || files.length === 0) {
			res.status(400).json({ error: 'No files uploaded' })
			return
		}

		// Normalize + extract metadata sequentially. Sequential (not Promise.all)
		// so we never run many ffmpeg transcodes at once and starve the real-time
		// busy-wait streaming engine. Normalization failures keep the original file.
		const results = []
		for (const f of files) {
			const norm = await normalizeInPlace(f.path)
			if (norm.status === 'failed') {
				console.warn(`[Upload] Normalization skipped for ${f.filename}: ${norm.error}`)
			}
			const metadata = await metadataManager.processUpload(f.filename, f.path)
			results.push({
				filename: f.filename,
				size: f.size,
				normalized: norm.status === 'normalized',
				sourceSampleRate: norm.sourceSampleRate,
				sourceLoudnessLufs: norm.status === 'failed' ? null : norm.sourceLoudnessLufs,
				metadata: {
					title: metadata.title,
					artist: metadata.artist,
					album: metadata.album,
					extractedFromId3: metadata.extractedFromId3,
				},
			})
		}

		// Add each track to playlist dynamically
		for (const file of files) {
			playlistManager.addTrack(file.filename)
		}

		res.json({
			success: true,
			count: files.length,
			files: results,
			message: `${files.length} song(s) uploaded successfully`,
		})
	},
)

/**
 * Delete a song
 * DELETE /admin/songs/:filename
 * Headers: X-API-Key: <your-api-key>
 */
app.delete('/admin/songs/:filename', requireAuth, (req: Request, res: Response) => {
	const filename = req.params.filename
	if (!filename) {
		res.status(400).json({ error: 'Filename required' })
		return
	}
	const filepath = path.join(SONGS_DIR, filename)

	// Security: prevent path traversal
	if (!filepath.startsWith(SONGS_DIR)) {
		res.status(400).json({ error: 'Invalid filename' })
		return
	}

	if (!fs.existsSync(filepath)) {
		res.status(404).json({ error: 'Song not found' })
		return
	}

	try {
		// Remove from playlist first (this may trigger skip if currently playing)
		playlistManager.removeTrack(filename)

		// Then delete the file and metadata
		fs.unlinkSync(filepath)
		metadataManager.delete(filename)

		res.json({
			success: true,
			message: `Deleted ${filename}`,
		})
	} catch (error) {
		res.status(500).json({
			error: 'Failed to delete song',
			message: error instanceof Error ? error.message : 'Unknown error',
		})
	}
})

/**
 * Get metadata for a track
 * GET /admin/tracks/:filename/metadata
 * Headers: X-API-Key: <your-api-key>
 */
app.get('/admin/tracks/:filename/metadata', requireAuth, async (req: Request, res: Response) => {
	const filename = req.params.filename
	if (!filename) {
		res.status(400).json({ error: 'Filename required' })
		return
	}
	const filepath = path.join(SONGS_DIR, filename)

	// Security: prevent path traversal
	if (!filepath.startsWith(SONGS_DIR)) {
		res.status(400).json({ error: 'Invalid filename' })
		return
	}

	if (!fs.existsSync(filepath)) {
		res.status(404).json({ error: 'Song not found' })
		return
	}

	const metadata = await metadataManager.getOrExtract(filename, filepath)
	res.json({ filename, metadata })
})

/**
 * Update metadata for a track
 * PATCH /admin/tracks/:filename/metadata
 * Headers: X-API-Key: <your-api-key>
 * Body: { title?, artist?, album?, albumArtUrl?, spotifyUrl?, youtubeUrl?, appleMusicUrl? }
 */
app.patch('/admin/tracks/:filename/metadata', requireAuth, (req: Request, res: Response) => {
	const filename = req.params.filename
	if (!filename) {
		res.status(400).json({ error: 'Filename required' })
		return
	}
	const filepath = path.join(SONGS_DIR, filename)

	// Security: prevent path traversal
	if (!filepath.startsWith(SONGS_DIR)) {
		res.status(400).json({ error: 'Invalid filename' })
		return
	}

	if (!fs.existsSync(filepath)) {
		res.status(404).json({ error: 'Song not found' })
		return
	}

	const { title, artist, album, albumArtUrl, spotifyUrl, youtubeUrl, appleMusicUrl } = req.body
	const updates: Record<string, string | undefined> = {}

	if (title !== undefined) updates.title = title
	if (artist !== undefined) updates.artist = artist
	if (album !== undefined) updates.album = album
	if (albumArtUrl !== undefined) updates.albumArtUrl = albumArtUrl
	if (spotifyUrl !== undefined) updates.spotifyUrl = spotifyUrl
	if (youtubeUrl !== undefined) updates.youtubeUrl = youtubeUrl
	if (appleMusicUrl !== undefined) updates.appleMusicUrl = appleMusicUrl

	if (Object.keys(updates).length === 0) {
		res.status(400).json({ error: 'No updates provided' })
		return
	}

	const metadata = metadataManager.update(filename, updates)

	// Rescan to update track info in playlist
	playlistManager.rescan()

	res.json({
		success: true,
		filename,
		metadata,
	})
})

/**
 * List all songs
 * GET /admin/songs
 * Headers: X-API-Key: <your-api-key>
 */
app.get('/admin/songs', requireAuth, (req: Request, res: Response) => {
	const files = fs
		.readdirSync(SONGS_DIR)
		.filter(f => f.endsWith('.mp3'))
		.map(f => {
			const stats = fs.statSync(path.join(SONGS_DIR, f))
			return {
				filename: f,
				size: stats.size,
				modified: stats.mtime,
			}
		})

	res.json({
		count: files.length,
		songs: files,
	})
})

/**
 * Backup endpoint — streams a tar.gz of the entire songs/ dir
 * (MP3 files + .radio-state/ with state.json & tracks-meta.json).
 * GET /admin/backup
 */
app.get('/admin/backup', requireAuth, (req: Request, res: Response) => {
	res.setHeader('Content-Type', 'application/gzip')
	res.setHeader('Content-Disposition', 'attachment; filename="lofi-radio-backup.tar.gz"')

	// Stream tar.gz of songs/ straight to the response (no in-memory buffering).
	// -C parents so the archive contains relative paths rooted at songs/.
	const proc = Bun.spawn(['tar', '-czf', '-', '-C', path.dirname(SONGS_DIR), path.basename(SONGS_DIR)], {
		stdout: 'pipe',
		stderr: 'pipe',
	})

	const reader = proc.stdout.getReader()
	const pump = async () => {
		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				if (!res.write(value)) {
					// Respect backpressure
					await new Promise<void>(resolve => res.once('drain', resolve))
				}
			}
			res.end()
		} catch (err) {
			console.error('[Backup] Stream error:', err)
			if (!res.headersSent) res.status(500).end()
			else res.end()
		}
	}

	// If the client disconnects, kill the tar process so it doesn't linger.
	res.on('close', () => proc.kill())

	pump()
})

// ─────────────────────────────────────────────────────────────────────────────
// DJ CONTROLS (campaign branch)
//
// These drive the SINGLE GLOBAL BROADCAST: a jump or seek changes what every
// listener hears, not just the caller. That is intentional for auditioning clips
// locally, and is why both routes are admin-gated. Do not deploy this branch to a
// public instance without revisiting that trade-off.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Jump the station to a specific track, optionally starting at an offset.
 * POST /admin/dj/play
 * Body: { filename: string, startMs?: number }
 */
app.post('/admin/dj/play', requireAuth, (req: Request, res: Response) => {
	const { filename, startMs } = req.body ?? {}

	if (typeof filename !== 'string' || filename.length === 0) {
		res.status(400).json({ error: 'filename (string) is required' })
		return
	}

	// Path traversal guard, matching the other admin routes.
	const filepath = path.join(SONGS_DIR, filename)
	if (!filepath.startsWith(SONGS_DIR)) {
		res.status(400).json({ error: 'Invalid filename' })
		return
	}

	// No upper bound: seekToMs clamps at EOF, so the route needs no duration lookup.
	let startAtMs = 0
	if (startMs !== undefined) {
		if (typeof startMs !== 'number' || !Number.isFinite(startMs) || startMs < 0) {
			res.status(400).json({ error: 'startMs must be a finite number >= 0' })
			return
		}
		startAtMs = startMs
	}

	// Move the playlist cursor first, then tell the engine — so that when the
	// engine commits, the playlist hands back the track we asked for.
	const track = playlistManager.jumpToTrack(filename)
	if (!track) {
		res.status(404).json({ error: 'Track not found in playlist' })
		return
	}

	engine.requestPlayTrack(track, startAtMs)

	res.json({ success: true, track, startMs: startAtMs })
})

/**
 * Seek within the currently playing track.
 * POST /admin/dj/seek
 * Body: { positionMs: number }
 */
app.post('/admin/dj/seek', requireAuth, (req: Request, res: Response) => {
	const { positionMs } = req.body ?? {}

	if (typeof positionMs !== 'number' || !Number.isFinite(positionMs) || positionMs < 0) {
		res.status(400).json({ error: 'positionMs must be a finite number >= 0' })
		return
	}

	if (!engine.getNowPlaying()) {
		res.status(409).json({ error: 'Nothing is currently playing' })
		return
	}

	engine.requestSeek(positionMs)

	res.json({ success: true, positionMs })
})

/**
 * Replace the clip markers on a track.
 * PUT /admin/tracks/:filename/clips
 * Body: { clips: Clip[] }  — wholesale replace; the client holds the full list.
 */
app.put('/admin/tracks/:filename/clips', requireAuth, (req: Request, res: Response) => {
	const filename = req.params.filename
	if (!filename) {
		res.status(400).json({ error: 'Filename required' })
		return
	}

	const filepath = path.join(SONGS_DIR, filename)
	if (!filepath.startsWith(SONGS_DIR)) {
		res.status(400).json({ error: 'Invalid filename' })
		return
	}

	if (!fs.existsSync(filepath)) {
		res.status(404).json({ error: 'Song not found' })
		return
	}

	// req.body is `any`; validateClips narrows from unknown with runtime checks.
	const result = validateClips(req.body?.clips)
	if (!result.ok) {
		res.status(400).json({ error: result.error })
		return
	}

	const clips = metadataManager.setClips(filename, result.clips)
	res.json({ success: true, filename, clips })
})

/**
 * All clip markers across the library, keyed by filename (export + UI badges).
 * GET /admin/clips
 */
app.get('/admin/clips', requireAuth, (_req: Request, res: Response) => {
	res.json({ clips: metadataManager.getAllClips() })
})

/**
 * Rescan playlist
 * POST /admin/rescan
 * Headers: X-API-Key: <your-api-key>
 */
app.post('/admin/rescan', requireAuth, (req: Request, res: Response) => {
	playlistManager.rescan()
	res.json({
		success: true,
		message: 'Playlist rescanned',
		trackCount: playlistManager.getTracks().length,
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// PLAYLIST API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get all tracks and current playing index
 */
app.get('/api/tracks', (req: Request, res: Response) => {
	res.json({
		tracks: playlistManager.getTracks(),
		currentIndex: playlistManager.getCurrentIndex(),
	})
})

/**
 * SSE endpoint for playlist/track updates
 */
app.get('/api/playlist/events', (req: Request, res: Response) => {
	playlistManager.addSSEClient(res, getQueryParam(req.query.sid))
})

// ─────────────────────────────────────────────────────────────────────────────
// STATIC FILES (Web Player)
// ─────────────────────────────────────────────────────────────────────────────

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, '../public')))

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────

// Start the streaming engine in the background
engine.start(
	async () => playlistManager.peekNextTrack(),
	async track => {
		const committedTrack = playlistManager.commitNextTrack()

		if (!committedTrack) {
			return undefined
		}

		if (committedTrack.id !== track.id) {
			console.warn(
				`[Server] Track commit mismatch. Expected ${track.title}, got ${committedTrack.title}. Using committed track.`,
			)
		}

		playlistManager.notifyTrackChange(committedTrack)
		return committedTrack
	},
)

// Graceful shutdown
const shutdown = () => {
	console.log('\nShutting down...')
	engine.stop()
	playlistManager.stop()
	process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Start listening
const PORT = process.env.PORT || 5634

app.listen(PORT, () => {
	console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    🎵 RADIO SERVER RUNNING                    ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Audio Stream:    http://localhost:${PORT}/stream               ║
║  Now Playing:     http://localhost:${PORT}/now-playing          ║
║  Live Updates:    http://localhost:${PORT}/now-playing/events   ║
║  Status:          http://localhost:${PORT}/status               ║
║                                                               ║
║  Test the stream:                                             ║
║  curl -N http://localhost:${PORT}/stream | mpv -                ║
║                                                               ║
║  Or open in browser:                                          ║
║  http://localhost:${PORT}                                       ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `)
})
