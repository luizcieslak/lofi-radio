/**
 * EXPRESS RADIO STREAMING SERVER
 * ==============================
 *
 * A complete, working radio server using Express.
 * Streams MP3 files to multiple listeners in sync with live metadata updates.
 */

import * as path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import { playlistManager } from './playlistManager'
import { StreamEngine } from './streamEngine'

// ============================================================================
// EXPRESS SERVER
// ============================================================================

const app = express()
const engine = new StreamEngine()

// Middleware
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
// ADMIN ROUTES (would add auth middleware in production)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Skip current track (placeholder - would need more implementation)
 */
app.post('/admin/skip', (req: Request, res: Response) => {
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
