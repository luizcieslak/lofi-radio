/**
 * EXPRESS RADIO STREAMING SERVER
 * ==============================
 *
 * A complete, working radio server using Express.
 * Streams MP3 files to multiple listeners in sync with live metadata updates.
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import express, { type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { playlistManager } from './playlistManager'
import { StreamEngine } from './streamEngine'

// ============================================================================
// EXPRESS SERVER
// ============================================================================

const app = express()
const engine = new StreamEngine()

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
		// Keep original filename
		cb(null, file.originalname)
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
			cb(new Error('Only MP3 files are allowed'))
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

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main audio stream endpoint
 * Connect with: <audio src="http://localhost:3000/stream">
 */
app.get('/stream', (req: Request, res: Response) => {
	engine.addClient(res)
	// Note: we don't call res.end() - the response stays open
})

/**
 * Get current track info (JSON)
 */
app.get('/now-playing', (req: Request, res: Response) => {
	const nowPlaying = engine.getNowPlaying()
	res.json(nowPlaying || { track: null })
})

/**
 * Server-Sent Events for live metadata updates
 * Connect with: new EventSource("/now-playing/events")
 */
app.get('/now-playing/events', (req: Request, res: Response) => {
	engine.addSSEClient(res)
})

/**
 * Server status
 */
app.get('/status', (req: Request, res: Response) => {
	res.json(engine.getStatus())
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
app.post('/admin/upload', requireAuth, upload.single('song'), (req: Request, res: Response) => {
	if (!req.file) {
		res.status(400).json({ error: 'No file uploaded' })
		return
	}

	// Rescan playlist to include new song
	playlistManager.rescan()

	res.json({
		success: true,
		filename: req.file.filename,
		size: req.file.size,
		message: 'Song uploaded successfully',
	})
})

/**
 * Upload multiple songs
 * POST /admin/upload/batch
 * Headers: X-API-Key: <your-api-key>
 * Body: multipart/form-data with 'songs[]' field (multiple files)
 */
app.post('/admin/upload/batch', requireAuth, upload.array('songs', 100), (req: Request, res: Response) => {
	const files = req.files as Express.Multer.File[]

	if (!files || files.length === 0) {
		res.status(400).json({ error: 'No files uploaded' })
		return
	}

	// Rescan playlist to include new songs
	playlistManager.rescan()

	res.json({
		success: true,
		count: files.length,
		files: files.map(f => ({
			filename: f.filename,
			size: f.size,
		})),
		message: `${files.length} song(s) uploaded successfully`,
	})
})

/**
 * Delete a song
 * DELETE /admin/songs/:filename
 * Headers: X-API-Key: <your-api-key>
 */
app.delete('/admin/songs/:filename', requireAuth, (req: Request, res: Response) => {
	const filename = req.params.filename
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
		fs.unlinkSync(filepath)
		playlistManager.rescan()
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
 * List all songs
 * GET /admin/songs
 * Headers: X-API-Key: <your-api-key>
 */
app.get('/admin/songs', requireAuth, (req: Request, res: Response) => {
	const files = fs.readdirSync(SONGS_DIR)
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

/**
 * Skip current track (placeholder - would need more implementation)
 */
app.post('/admin/skip', requireAuth, (req: Request, res: Response) => {
	// In a real implementation, you'd signal the engine to skip
	res.json({ message: 'Skip requested' })
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
	playlistManager.addSSEClient(res)
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
engine.start(async () => {
	const track = playlistManager.getNextTrack()
	if (track) {
		// Notify playlist manager of track change for SSE clients
		playlistManager.notifyTrackChange(track)
	}
	return track
})

// Graceful shutdown
const shutdown = () => {
	console.log('\nShutting down...')
	engine.stop()
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
