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
import { metadataManager } from './metadataManager'
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
app.post('/admin/upload', requireAuth, upload.single('song'), async (req: Request, res: Response) => {
	if (!req.file) {
		res.status(400).json({ error: 'No file uploaded' })
		return
	}

	// Extract ID3 metadata and store
	const metadata = await metadataManager.processUpload(req.file.filename, req.file.path)

	// Rescan playlist to include new song
	playlistManager.rescan()

	res.json({
		success: true,
		filename: req.file.filename,
		size: req.file.size,
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

		// Extract metadata for all uploaded files
		const results = await Promise.all(
			files.map(async f => {
				const metadata = await metadataManager.processUpload(f.filename, f.path)
				return {
					filename: f.filename,
					size: f.size,
					metadata: {
						title: metadata.title,
						artist: metadata.artist,
						album: metadata.album,
						extractedFromId3: metadata.extractedFromId3,
					},
				}
			}),
		)

		// Rescan playlist to include new songs
		playlistManager.rescan()

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
		fs.unlinkSync(filepath)
		metadataManager.delete(filename) // Also remove metadata
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
 * Body: { title?, artist?, album?, albumArtUrl? }
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

	const { title, artist, album, albumArtUrl } = req.body
	const updates: Record<string, string | undefined> = {}

	if (title !== undefined) updates.title = title
	if (artist !== undefined) updates.artist = artist
	if (album !== undefined) updates.album = album
	if (albumArtUrl !== undefined) updates.albumArtUrl = albumArtUrl

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
