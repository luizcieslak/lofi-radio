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
import { archiveRecordings } from '../scripts/archiveRecordings'
import { normalizeInPlace } from './audioNormalizer'
import { validateClips } from './clipValidation'
import { metadataManager } from './metadataManager'
import { playlistManager } from './playlistManager'
import { OUTPUT_DIR, recordingFilename } from './recordingPaths'
import { type RenderScope, renderRunner } from './renderRunner'
import { GLOW_FLAGS, GLOW_NUMBERS } from './sceneGlow'
import { DEFAULT_SCENE_PULSE } from './scenePulse'
import { StreamEngine } from './streamEngine'
import { isTrackTheme, TRACK_THEMES } from './types'

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
const RECORDINGS_DIR = path.join(__dirname, '..', OUTPUT_DIR)
const PORT = process.env.PORT || 5634

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
	res.json(nowPlaying || { track: null })
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
 * Body: { title?, artist?, album?, albumArtUrl?, theme?, spotifyUrl?, youtubeUrl?, appleMusicUrl? }
 *
 * `theme` is 'light' | 'dark', or null to clear it back to "no opinion".
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

	const { title, artist, album, albumArtUrl, theme, spotifyUrl, youtubeUrl, appleMusicUrl } = req.body
	const updates: Record<string, string | undefined> = {}

	// Unlike the free-text fields, `theme` is a closed union the player branches
	// on, so an unrecognized value is rejected rather than stored. Validate before
	// applying anything, so a bad theme doesn't half-apply the other fields.
	// `null` clears it back to "no opinion"; omitting the key leaves it alone.
	const clearsTheme = theme === null
	if (theme !== undefined && !clearsTheme && !isTrackTheme(theme)) {
		res.status(400).json({ error: `theme must be one of ${TRACK_THEMES.join(', ')}, or null to clear` })
		return
	}

	if (title !== undefined) updates.title = title
	if (artist !== undefined) updates.artist = artist
	if (album !== undefined) updates.album = album
	if (albumArtUrl !== undefined) updates.albumArtUrl = albumArtUrl
	if (spotifyUrl !== undefined) updates.spotifyUrl = spotifyUrl
	if (youtubeUrl !== undefined) updates.youtubeUrl = youtubeUrl
	if (appleMusicUrl !== undefined) updates.appleMusicUrl = appleMusicUrl

	const touchesTheme = theme !== undefined
	if (Object.keys(updates).length === 0 && !touchesTheme) {
		res.status(400).json({ error: 'No updates provided' })
		return
	}

	// Theme goes through its own setter because it must be able to REMOVE the
	// field; see metadataManager.setTheme. Applied first, so that when the request
	// also carries other fields the `update()` below returns the fully-merged
	// entry and the response reflects both changes.
	const afterTheme = touchesTheme ? metadataManager.setTheme(filename, clearsTheme ? null : theme) : null

	// One of the two must have run: the guard above rejected the empty request.
	const metadata = Object.keys(updates).length > 0 ? metadataManager.update(filename, updates) : afterTheme

	// Rescan to update track info in playlist
	playlistManager.rescan()

	// rescan() rebuilds the playlist, but the engine holds its own snapshot of the
	// playing Track taken at track start. Without this, an edit to the track that
	// is playing right now would show up on /api/tracks while /now-playing (and
	// its SSE stream, and therefore the player) kept serving the stale values
	// until the next track change.
	const refreshed = playlistManager.getTracks().find(track => path.basename(track.path) === filename)
	if (refreshed) {
		engine.refreshNowPlayingTrack(refreshed)
	}

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
// SCENE EDITOR (campaign branch)
//
// Backs public/editor.html, where promo-video scenes are marked. Nothing here
// touches the broadcast: the editor plays the source file locally in the browser,
// so its playhead is exact instead of trailing the live stream by its buffer.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The raw source MP3, decoded with Web Audio by the scene editor and by the
 * site's pinned-track mode (which plays a scene's own audio silently into the
 * glow's analyser, so the pulse in a recording follows the audio that gets muxed).
 * GET /api/tracks/:filename/audio
 *
 * Public, unlike the rest of this section: the site fetches it cross-origin with
 * no API key, and keys don't belong in page URLs. The same audio is already public
 * on /stream; this only makes whole files downloadable, which is fine for a
 * local-only campaign branch and is one more reason it must not be deployed.
 */
app.get('/api/tracks/:filename/audio', (req: Request, res: Response) => {
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

	res.sendFile(filepath)
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
	const clips = metadataManager.getAllClips()
	// The default pulse rides along so the editor applies exactly what the
	// recorder will, without keeping its own copy.
	res.json({
		clips,
		renders: findRenders(clips),
		defaultPulse: DEFAULT_SCENE_PULSE,
		// The editor builds its glow panel from these, so it can't drift from validation.
		glowControls: { numbers: GLOW_NUMBERS, flags: GLOW_FLAGS },
	})
})

/** Where a scene's render can be fetched: GET /api/recordings/:file. */
interface SceneRender {
	url: string
	sizeBytes: number
	/** The file's mtime (epoch ms). */
	renderedAt: number
}

/**
 * The render of every scene that has one, keyed by scene id.
 *
 * Looked up on disk by the recorder's own naming (src/recordingPaths.ts) rather
 * than stored on the scene, so it is never stale: an archived or deleted render
 * simply stops being found. `?v=` busts the cache when a scene is re-rendered.
 */
function findRenders(clips: Record<string, { id: string }[]>): Record<string, SceneRender> {
	const renders: Record<string, SceneRender> = {}
	for (const [filename, trackClips] of Object.entries(clips)) {
		for (const clip of trackClips) {
			const file = recordingFilename(filename, clip.id)
			try {
				const stats = fs.statSync(path.join(RECORDINGS_DIR, file))
				if (!stats.isFile()) continue
				renders[clip.id] = {
					url: `/api/recordings/${encodeURIComponent(file)}?v=${Math.round(stats.mtimeMs)}`,
					sizeBytes: stats.size,
					renderedAt: Math.round(stats.mtimeMs),
				}
			} catch {
				// Not rendered (yet).
			}
		}
	}
	return renders
}

/**
 * A rendered scene video.
 * GET /api/recordings/:file
 *
 * Public, like the source audio above, so the editor can link and play it with a
 * plain <a>/<video>, which cannot send an API key. Only top-level MP4s are served,
 * never `backup/` or the recorder's `.work-*` dirs. One more reason this branch
 * must not be deployed.
 */
app.get('/api/recordings/:file', (req: Request, res: Response) => {
	const file = req.params.file
	if (!file || !/^[^/\\]+\.mp4$/.test(file) || file.startsWith('.')) {
		res.status(400).json({ error: 'Invalid recording name' })
		return
	}
	const filepath = path.join(RECORDINGS_DIR, file)
	if (path.dirname(filepath) !== RECORDINGS_DIR || !fs.existsSync(filepath)) {
		res.status(404).json({ error: 'Recording not found' })
		return
	}
	// sendFile answers Range requests, so the video can seek.
	res.sendFile(filepath)
})

/**
 * Read a render request's scope. `clipId` renders one scene (even if marked
 * recorded, as `--clip` does); `track` that track's scenes; neither, every scene.
 */
function parseRenderScope(body: unknown): { ok: true; scope: RenderScope } | { ok: false; error: string } {
	const field = (key: string): unknown =>
		typeof body === 'object' && body !== null ? Reflect.get(body, key) : undefined
	const clipId = field('clipId')
	const track = field('track')
	const includeRecorded = field('includeRecorded') === true
	if (clipId !== undefined && track !== undefined)
		return { ok: false, error: 'Pass clipId or track, not both' }
	if (clipId !== undefined) {
		if (typeof clipId !== 'string' || clipId === '') return { ok: false, error: 'clipId must be a string' }
		return { ok: true, scope: { kind: 'clip', clipId } }
	}
	if (track !== undefined) {
		if (typeof track !== 'string' || track === '') return { ok: false, error: 'track must be a filename' }
		return { ok: true, scope: { kind: 'track', filename: track, includeRecorded } }
	}
	return { ok: true, scope: { kind: 'all', includeRecorded } }
}

/** The site to film; only http(s), since it ends up in a browser's address bar. */
function parseSiteUrl(value: unknown): { ok: true; siteUrl?: string } | { ok: false; error: string } {
	if (value === undefined || value === '') return { ok: true }
	if (typeof value !== 'string') return { ok: false, error: 'siteUrl must be a string' }
	try {
		const url = new URL(value)
		if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
		return { ok: true, siteUrl: value.replace(/\/+$/, '') }
	} catch {
		return { ok: false, error: 'siteUrl must be an http(s) URL' }
	}
}

/**
 * Start a render of scenes, or with `dryRun` only plan one.
 * POST /admin/renders
 * Body: { clipId? | track?, includeRecorded?, dryRun?, siteUrl? }
 *
 * Runs scripts/recordClips.ts (src/renderRunner.ts). A dry run answers
 * `{ jobs }` — what would render — and leaves the current run alone; a real one
 * answers the run snapshot, which GET /admin/renders then tracks.
 */
app.post('/admin/renders', requireAuth, async (req: Request, res: Response) => {
	const scope = parseRenderScope(req.body)
	if (!scope.ok) {
		res.status(400).json({ error: scope.error })
		return
	}
	const site = parseSiteUrl(req.body?.siteUrl)
	if (!site.ok) {
		res.status(400).json({ error: site.error })
		return
	}
	const environment = { radioUrl: `http://localhost:${PORT}`, siteUrl: site.siteUrl }

	if (req.body?.dryRun === true) {
		try {
			res.json({ jobs: await renderRunner.plan(scope.scope, environment) })
		} catch (error) {
			res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
		}
		return
	}

	if (renderRunner.isRunning()) {
		res.status(409).json({ error: 'A render is already running', run: renderRunner.snapshot() })
		return
	}
	res.json({ run: renderRunner.start(scope.scope, environment) })
})

/**
 * The current (or last) render run, polled by the editor while one is active.
 * GET /admin/renders
 */
app.get('/admin/renders', requireAuth, (_req: Request, res: Response) => {
	res.json({ run: renderRunner.snapshot() })
})

/**
 * Cancel the running render.
 * DELETE /admin/renders
 */
app.delete('/admin/renders', requireAuth, (_req: Request, res: Response) => {
	if (!renderRunner.cancel()) {
		res.status(409).json({ error: 'No render is running' })
		return
	}
	res.json({ run: renderRunner.snapshot() })
})

/**
 * Move every render into recordings/backup/<stamp>/ (scripts/archiveRecordings.ts).
 * POST /admin/recordings/archive
 * Body: { dryRun? }  — a dry run lists what would move, for the confirmation.
 *
 * Refused mid-render: it would move a batch's finished files out from under it.
 */
app.post('/admin/recordings/archive', requireAuth, async (req: Request, res: Response) => {
	if (renderRunner.isRunning()) {
		res.status(409).json({ error: 'A render is running; archive once it finishes' })
		return
	}
	try {
		const result = await archiveRecordings({ dryRun: req.body?.dryRun === true, outputDir: RECORDINGS_DIR })
		res.json({
			moved: result.moved,
			target: result.target && path.relative(path.join(__dirname, '..'), result.target),
		})
	} catch (error) {
		res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
	}
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
	// A render left running would orphan its browser past the server's exit.
	renderRunner.cancel()
	engine.stop()
	playlistManager.stop()
	process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Start listening

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
