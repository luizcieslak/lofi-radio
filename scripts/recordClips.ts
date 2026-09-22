/**
 * BATCH CLIP RECORDER (campaign branch)
 *
 * Renders every marked clip into a vertical promo video, unattended.
 *
 * For each clip: put the track on the air at the clip's start, screen-record the
 * `cieslak-dev` radio page with Playwright, cut the audio slice straight from the
 * source MP3, and mux the two into an H.264/AAC MP4.
 *
 * The audio never comes from the capture. Playwright records no audio at all, and
 * even if it did, captured audio would carry the burst-buffer latency, the seek
 * artifact, and a second generational loss on already-lossy MP3. Cutting from
 * `songs/*.mp3` is sample-exact, because the server streams those files
 * frame-by-frame with no transformation at serve time.
 *
 *   Playwright  -> silent video, exact duration, vertical framing
 *   ffmpeg -ss  -> lossless audio slice from songs/*.mp3
 *   ffmpeg mux  -> the clip, with a fade-out on both streams
 *
 * Usage:
 *   bun run scripts/recordClips.ts                       # every marked clip
 *   bun run scripts/recordClips.ts --track "Novel.mp3"   # one track's clips
 *   bun run scripts/recordClips.ts --clip a1b2c3         # one clip
 *   bun run scripts/recordClips.ts --dry-run             # plan only, record nothing
 *
 * Requires the radio running locally on `campaign/dj-controls` (the DJ routes are
 * branch-local), the site running on :4321, RADIO_API_KEY, ffmpeg, and Playwright
 * with a full Chromium — `chromium_headless_shell` cannot record video.
 *
 * ⚠️ Every render puts a track on the air. The DJ routes drive the SINGLE GLOBAL
 * BROADCAST, so this must only ever run against a local server. See
 * docs/video-recording.md.
 */

// The callbacks passed to addInitScript/waitForFunction/evaluate are serialized
// and run inside Chromium, so they touch `document`. The project's tsconfig sets
// `lib: ["esnext"]` — correct for a server — so DOM types are pulled in here only,
// rather than widening the lib for everything.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { spawn } from 'node:child_process'
import { access, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Clip } from '../src/types'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RADIO_URL = process.env.RADIO_URL ?? 'http://localhost:5634'
const SITE_URL = process.env.SITE_URL ?? 'http://localhost:4321'
const API_KEY = process.env.RADIO_API_KEY ?? ''

/** Vertical, the shape Shorts / Reels / TikTok actually want. */
const WIDTH = 1080
const HEIGHT = 1920
const FPS = 30

/**
 * Length of the fade-to-black / fade-to-silence at the end of every clip.
 *
 * The fade runs INSIDE the marked slice — it starts `FADE_SECONDS` before the
 * clip's `endMs` — so the clip still ends exactly where it was marked rather than
 * running past it. A clip shorter than the fade gets a proportionally shorter one
 * (see `fadeStart`), since a 2s fade on a 1.5s clip would start before it begins.
 */
const FADE_SECONDS = 2

/**
 * Rough per-clip overhead for the time estimate: browser launch, navigation,
 * waiting on artwork, the settle, and the encode. Not load-bearing — it only
 * makes the upfront "this will take N minutes" honest.
 */
const SETUP_SECONDS = 8

/**
 * Output frame rate. The page paints at a variable rate (~45fps observed), so
 * frames are resampled onto this fixed timeline — one written per slot, the most
 * recent one repeated when the page is idle. 30 is the usual delivery rate for
 * this kind of clip and keeps the encode cheap.
 */
const FRAME_RATE = 30

/**
 * Ceiling on `chromium.launch()`. A cold start is a couple of seconds; this is
 * generous so it only ever catches a launch that is never coming back.
 */
const LAUNCH_TIMEOUT_MS = 60_000

/** How long to wait for the screencast's first frame before calling it dead. */
const FIRST_FRAME_TIMEOUT_MS = 10_000

/**
 * How long the page may go without producing a frame before the capture is
 * treated as dead. A static page legitimately sends nothing for a while, so this
 * is well above any normal gap: it exists to catch a browser that has stopped,
 * not to police the paint rate.
 */
const FRAME_STALL_TIMEOUT_MS = 5_000

/**
 * Ceiling on the encoder's exit after its stdin is closed. It has already been
 * fed every frame by this point, so this only catches a child that never reaps.
 */
const ENCODER_TIMEOUT_MS = 60_000

/**
 * How close to the track's end a clip must be marked to count as running to the
 * end of the song. Marks are set by ear against a decoded duration, so they land
 * a little short or long; this is the slop that treats those as the same intent.
 */
const TRACK_END_TOLERANCE_SECONDS = 1.5

/** The page is visually static, but give the glow/drift a moment to settle. */
const SETTLE_MS = 1500

/** A cover that never loads leaves a blank square in frame — fail instead. */
const CONTENT_TIMEOUT_MS = 15_000

/** Ceiling on the initial navigation; the page is local, so this is generous. */
const NAVIGATION_TIMEOUT_MS = 30_000

/** The radio needs a moment to actually be streaming the new position. */
const ON_AIR_SETTLE_MS = 1200

/**
 * Slack allowed for the whole in-browser phase *on top of* the capture's own real
 * time: launch, navigate, await artwork, play, finalize.
 *
 * `CLOSE_TIMEOUT_MS` alone is not enough. Every await in that phase is a protocol
 * round-trip to the browser, so when the capture encoder wedges, the *page* stops
 * responding and the script hangs at whichever call it happens to be in — observed
 * in a 15-clip batch stalling 29 minutes inside `page.waitForTimeout`, well before
 * `context.close()` was ever reached. Bounding only the close guards one point on
 * a path where any point can hang; this bounds the path.
 *
 * It must be slack rather than a fixed ceiling: the phase contains a capture that
 * runs in real time, so a constant shrinks to nothing as clips get longer. At a
 * flat 90s a 57s clip had 33s for everything else and tripped the outer deadline
 * before the inner `CLOSE_TIMEOUT_MS` could name the close as the culprit.
 */
const CAPTURE_SLACK_MS = 90_000

/**
 * Ceiling on any single ffmpeg/ffprobe invocation. Encoding a 60s 1080x1920 clip
 * at `preset slow` takes well under a minute on normal hardware; this only exists
 * so a wedged child fails its clip instead of the whole batch. The encode treats
 * hitting it as inconclusive rather than fatal (a zombie ffmpeg still leaves a
 * valid file), so it can be tight enough not to stall a batch for long.
 */
const SUBPROCESS_TIMEOUT_MS = 120_000

const OUTPUT_DIR = 'recordings'
const SONGS_DIR = 'songs'

/**
 * Drift parameters for the visual gradient, as query flags on the radio page.
 * `stage` is the important one: it hides nav, footer, miniplayer, and the play
 * button so only the artwork and title are in frame.
 */
const PAGE_FLAGS = 'drift=12&driftSpeed=3&stage'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClipsResponse {
	clips: Record<string, Clip[]>
}

interface RenderJob {
	filename: string
	clip: Clip
	outputPath: string
	durationSeconds: number
}

interface RenderResult {
	job: RenderJob
	ok: boolean
	error?: string
}

// ---------------------------------------------------------------------------
// Small process helpers
// ---------------------------------------------------------------------------

/**
 * Run a command to completion, capturing output.
 *
 * ffmpeg writes progress to stderr even on success, so stderr is only surfaced
 * when the exit code is non-zero.
 */
function run(
	command: string,
	args: string[],
	timeoutMs: number = SUBPROCESS_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		let settled = false

		/**
		 * Bound every subprocess, not just the capture.
		 *
		 * `close` fires only once the process has exited AND its stdio is drained,
		 * so a wedged or un-reaped child leaves this promise pending forever — which
		 * stalled an unattended batch during testing. SIGKILL rather than SIGTERM:
		 * the processes that actually wedge here ignore the polite signal.
		 */
		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			child.kill('SIGKILL')
			reject(new Error(`${command} did not finish within ${timeoutMs / 1000}s`))
		}, timeoutMs)
		// Not unref'd: if the child dies without reporting, this timer can be the
		// only handle left, and an unref'd one would let Node idle forever instead
		// of firing. It is always cleared in `finish`.

		const finish = (run: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			run()
		}

		// Both pipes must be drained. ffmpeg's `-f null -` writes the muxer output to
		// stdout while its report goes to stderr; leaving either unread risks the
		// child blocking on a full pipe buffer.
		child.stdout.on('data', chunk => {
			stdout += String(chunk)
		})
		child.stderr.on('data', chunk => {
			stderr += String(chunk)
		})
		child.on('error', error => finish(() => reject(error)))
		child.on('close', code => {
			finish(() => {
				if (code === 0) resolve({ stdout, stderr })
				else reject(new Error(`${command} exited ${code}\n${stderr.trim()}`))
			})
		})
	})
}

/** Probe a single numeric field out of a media file. */
async function probeDuration(file: string): Promise<number> {
	const { stdout } = await run('ffprobe', [
		'-v',
		'error',
		'-show_entries',
		'format=duration',
		'-of',
		'csv=p=0',
		file,
	])
	const duration = Number(stdout.trim())
	if (!Number.isFinite(duration) || duration <= 0) {
		throw new Error(`could not read a duration from ${file} (got ${JSON.stringify(stdout.trim())})`)
	}
	return duration
}

async function exists(file: string): Promise<boolean> {
	try {
		await access(file)
		return true
	} catch {
		return false
	}
}

/**
 * Reject a promise that takes too long, so a hung operation cannot stall a batch.
 *
 * The underlying work is NOT cancelled — nothing here can un-wedge a deadlocked
 * child process — so callers must still tear down whatever owns it (for the
 * capture, that is `browser.close()` in the `finally`).
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string | (() => string)): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		// A thunk is evaluated at timeout, so the message can report progress made
		// up to that moment rather than what was known when the timer was armed.
		/**
		 * Deliberately NOT `unref`'d. An unref'd timer does not keep the event loop
		 * alive, so when the thing being waited on dies and takes every other handle
		 * with it (a browser that exits mid-capture, killing its protocol sockets),
		 * Node has nothing left to run and simply idles — the timeout never fires and
		 * the process hangs forever. Observed: a 112s capture budget still pending
		 * after 18 minutes. The timer is always cleared below, so keeping it
		 * referenced cannot delay a normal exit.
		 */
		const timer = setTimeout(() => reject(new Error(typeof message === 'function' ? message() : message)), ms)
		promise.then(resolve, reject).finally(() => clearTimeout(timer))
	})
}

/**
 * Filesystem-safe name for an output file.
 *
 * Track filenames in this library include spaces, apostrophes, parentheses, and
 * full-width unicode (e.g. "ＥＬＡ　ＭＯＲＡ..."), none of which we want in a
 * filename that gets dragged into a video editor.
 */
function slugify(input: string): string {
	return (
		input
			// NFKD splits accented and full-width characters into a base plus combining
			// marks, which \p{M} then strips — so "Café" becomes "cafe", not "caf".
			.normalize('NFKD')
			.replace(/\p{M}/gu, '')
			.replace(/\.mp3$/i, '')
			.replace(/[^a-zA-Z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.toLowerCase() || 'track'
	)
}

// ---------------------------------------------------------------------------
// Radio API
// ---------------------------------------------------------------------------

function adminHeaders(): Record<string, string> {
	return { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' }
}

async function fetchClips(): Promise<Record<string, Clip[]>> {
	const response = await fetch(`${RADIO_URL}/admin/clips`, { headers: adminHeaders() })
	if (!response.ok) {
		throw new Error(`GET /admin/clips -> ${response.status} ${response.statusText}`)
	}
	const body: unknown = await response.json()
	if (typeof body !== 'object' || body === null || !('clips' in body)) {
		throw new Error('GET /admin/clips returned an unexpected shape')
	}
	const { clips } = body as ClipsResponse
	if (typeof clips !== 'object' || clips === null) {
		throw new Error('GET /admin/clips returned a non-object `clips`')
	}
	return clips
}

/** Put a track on the air at an offset. This changes what every listener hears. */
async function playAt(filename: string, startMs: number): Promise<void> {
	const response = await fetch(`${RADIO_URL}/admin/dj/play`, {
		method: 'POST',
		headers: adminHeaders(),
		body: JSON.stringify({ filename, startMs }),
	})
	if (!response.ok) {
		throw new Error(`POST /admin/dj/play (${filename} @${startMs}) -> ${response.status}`)
	}
}

/** The `path` of whatever the station is currently broadcasting. */
async function nowPlayingPath(): Promise<string | null> {
	const response = await fetch(`${RADIO_URL}/now-playing`)
	if (!response.ok) return null
	const body: unknown = await response.json()
	if (typeof body !== 'object' || body === null || !('track' in body)) return null
	const { track } = body as { track: unknown }
	if (typeof track !== 'object' || track === null || !('path' in track)) return null
	const { path: trackPath } = track as { path: unknown }
	return typeof trackPath === 'string' ? trackPath : null
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Record the page for `seconds`, returning the path to the raw silent video.
 *
 * Frames come from CDP's screencast rather than Playwright's `recordVideo`.
 * `recordVideo` deadlocks: reproduced reliably, the SECOND capture in a Node
 * process hangs in `context.close()` while its encoder still writes a complete
 * file, because finalization happens inside Playwright where we cannot reach it.
 * Driving the screencast directly puts the frame pipeline in this file -- the
 * close is then an ordinary protocol call (measured: 0.1s, three captures in a
 * row) and ffmpeg is our own child.
 *
 * The page paints at a variable rate, so frames are resampled onto a fixed
 * `FRAME_RATE` timeline: hold the most recent frame and emit exactly one per
 * slot, repeating it when the page is idle. That makes the output exactly
 * `seconds` long by construction rather than by trimming afterwards.
 */
async function captureVideo(outDir: string, seconds: number): Promise<string> {
	// Imported lazily so `--dry-run` and `--help` work without Playwright installed.
	const { chromium } = await import('playwright')

	/**
	 * `channel: 'chromium'` is load-bearing, not cosmetic. A bare `chromium.launch()`
	 * starts `chromium_headless_shell`, which cannot capture: it yields a 0-byte
	 * video and an encoder blocked on `pipe:0`. Only this channel selects the full
	 * browser.
	 */
	/**
	 * Bounded like everything else. `launch()` sits OUTSIDE the capture deadline
	 * below (that one wraps only the page work), so a launch that never returns was
	 * unguarded entirely — observed hanging a batch indefinitely on clip 3 with no
	 * browser, no encoder and no open handles, just an idle process.
	 */
	const browser = await withTimeout(
		chromium.launch({ channel: 'chromium' }),
		LAUNCH_TIMEOUT_MS,
		`the browser did not start within ${LAUNCH_TIMEOUT_MS / 1000}s`,
	)
	const videoPath = path.join(outDir, 'capture.mp4')

	// Registered as they spawn so the `finally` can reap one left by any throw.
	const encoders: ReturnType<typeof spawn>[] = []

	try {
		let phase = 'opening the page'
		const capture = async (): Promise<void> => {
			const context = await browser.newContext({
				viewport: { width: WIDTH, height: HEIGHT },
				deviceScaleFactor: 1,
			})

			/**
			 * The Astro dev toolbar injects a floating dark pill at the bottom of the
			 * viewport. It lives outside the page's own DOM, so `?stage` cannot hide
			 * it, and it sits squarely in frame on a 1080x1920 capture.
			 */
			await context.addInitScript(() => {
				const apply = () => {
					const style = document.createElement('style')
					style.textContent = 'astro-dev-toolbar{display:none !important}'
					document.head?.appendChild(style)
				}
				if (document.head) apply()
				else document.addEventListener('DOMContentLoaded', apply)
			})

			const page = await context.newPage()
			phase = 'navigating to the page'
			/**
			 * `domcontentloaded`, not `networkidle`. The radio page holds an SSE
			 * metadata stream and an audio stream open by design, so the network never
			 * reliably goes quiet for the 500ms `networkidle` requires -- it only
			 * passes when those happen to lull, and it timed out on two clips of a
			 * 15-clip batch. Readiness is established below by the artwork itself.
			 */
			await page.goto(`${SITE_URL}/en/radio/?${PAGE_FLAGS}`, {
				waitUntil: 'domcontentloaded',
				timeout: NAVIGATION_TIMEOUT_MS,
			})

			phase = 'waiting for the artwork to load'
			// Wait for the artwork itself, not merely the document. The cover IS the
			// shot; recording while it is still fetching yields an empty square.
			await page.waitForFunction(
				() => {
					const images = [...document.querySelectorAll('img')]
					return images.length > 0 && images.every(img => img.complete && img.naturalWidth > 0)
				},
				null,
				{ timeout: CONTENT_TIMEOUT_MS },
			)
			phase = 'waiting for the page to settle'
			await page.waitForTimeout(SETTLE_MS)

			// Start playback so the page is in its playing state. In stage mode the
			// button is transparent rather than removed, so it still works and still
			// stays out of frame.
			await page.evaluate(() => {
				const buttons = [...document.querySelectorAll('button')]
				const playButton = buttons.find(button =>
					/play|tocar|listen/i.test(button.getAttribute('aria-label') ?? button.textContent ?? ''),
				)
				playButton?.click()
			})

			// ffmpeg consumes JPEGs on stdin and encodes the final MP4 in one pass.
			// No intermediate .webm, so there is no second generational loss and no
			// separate trim step.
			const encoder = spawn(
				'ffmpeg',
				// biome-ignore format: one flag group per line reads better than a reflowed block
				[
					'-y',
					'-f', 'image2pipe',
					'-framerate', String(FRAME_RATE),
					'-i', 'pipe:0',
					'-c:v', 'libx264',
					'-preset', 'veryfast',
					'-crf', '20',
					'-pix_fmt', 'yuv420p',
					videoPath,
				],
				{ stdio: ['pipe', 'ignore', 'pipe'] },
			)
			let encoderError = ''
			encoder.stderr.on('data', chunk => {
				encoderError += String(chunk)
			})
			const encoderClosed = new Promise<number>(resolve => encoder.on('close', code => resolve(code ?? -1)))
			/**
			 * ffmpeg reads frames from a pipe, so it exits only when that pipe is
			 * closed. Every path out of this function must therefore close it: an
			 * early throw that skipped `stdin.end()` left ffmpeg waiting forever on a
			 * pipe nobody would ever close, holding the Node process open long past
			 * the capture deadline (observed: a 6.5s clip with a 48-byte file and a
			 * 12-minute encoder). `browser.close()` cannot reap it — it is our child,
			 * not the browser's.
			 */
			encoders.push(encoder)

			const cdp = await context.newCDPSession(page)
			let latest: Buffer | null = null
			let lastFrameAt = Date.now()
			cdp.on('Page.screencastFrame', async frame => {
				latest = Buffer.from(frame.data, 'base64')
				lastFrameAt = Date.now()
				// Chromium pauses the screencast until each frame is acknowledged.
				await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
			})
			phase = 'starting the screencast'
			await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 })

			// Slot 0 must have something to write.
			const firstFrameBy = Date.now() + FIRST_FRAME_TIMEOUT_MS
			while (latest === null) {
				if (Date.now() > firstFrameBy) throw new Error('the screencast produced no frames')
				await new Promise(resolve => setTimeout(resolve, 10))
			}

			phase = `holding for the ${seconds.toFixed(0)}s capture`
			const totalFrames = Math.round(seconds * FRAME_RATE)
			const startedAt = Date.now()
			for (let index = 0; index < totalFrames; index++) {
				const dueAt = startedAt + (index * 1000) / FRAME_RATE
				const wait = dueAt - Date.now()
				if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
				if (!encoder.stdin.writable) throw new Error('the encoder closed mid-capture')
				/**
				 * A browser that dies mid-capture stops delivering frames while this
				 * loop keeps writing, so the render silently becomes a freeze-frame
				 * rather than a failure. Seen while diagnosing exactly that: frames
				 * stopped at 163 of 210 and the run still "finished". Repeating the
				 * last frame is correct for an idle page (nothing changed), so the
				 * test is a stall long enough that only a dead page explains it.
				 */
				if (Date.now() - lastFrameAt > FRAME_STALL_TIMEOUT_MS) {
					throw new Error(
						`the page stopped producing frames after ${index} of ${totalFrames} ` +
							'(the browser most likely died mid-capture)',
					)
				}
				// `latest` is reassigned by the CDP handler between iterations.
				encoder.stdin.write(latest as Buffer)
			}

			phase = 'finishing the encode'
			await cdp.send('Page.stopScreencast').catch(() => {})
			encoder.stdin.end()
			const code = await withTimeout(encoderClosed, ENCODER_TIMEOUT_MS, 'the encoder did not exit')
			if (code !== 0) throw new Error(`ffmpeg exited ${code}\n${encoderError.trim()}`)

			phase = 'closing the browser context'
			await context.close()
		}

		// The capture itself is real time, so the budget is that plus slack; a fixed
		// ceiling would starve long clips. The message names the phase that never
		// returned: a capture can stall at any of them, and which one is the diagnosis.
		const captureBudgetMs = seconds * 1000 + CAPTURE_SLACK_MS
		await withTimeout(
			capture(),
			captureBudgetMs,
			() =>
				`stalled while ${phase} — no progress for ${(captureBudgetMs / 1000).toFixed(0)}s ` +
				'(this render is lost, the batch continues)',
		)

		const { size } = await stat(videoPath).catch(() => ({ size: 0 }))
		if (size === 0) throw new Error('the capture produced no video')
		return videoPath
	} finally {
		// Reachable after a timeout above, and the only thing that reaps the browser
		// and encoder left behind by one. Close stdin first so a live ffmpeg can
		// finish normally; SIGKILL is for one that ignores it.
		for (const encoder of encoders) {
			if (encoder.exitCode === null && encoder.signalCode === null) {
				encoder.stdin?.end()
				encoder.kill('SIGKILL')
			}
		}
		await browser.close().catch(() => {})
	}
}

// ---------------------------------------------------------------------------
// Render one clip
// ---------------------------------------------------------------------------

async function renderClip(job: RenderJob, workDir: string, step: (message: string) => void): Promise<void> {
	const { filename, clip, outputPath, durationSeconds } = job
	const sourceMp3 = path.join(SONGS_DIR, filename)

	if (!(await exists(sourceMp3))) {
		throw new Error(`source MP3 not found: ${sourceMp3}`)
	}

	/**
	 * Whether this clip runs to the end of the track, in which case the station is
	 * *expected* to advance and the drift check below must not treat it as a fault.
	 * Compared with a tolerance because the mark and the decoded duration are not
	 * sample-exact.
	 *
	 * The capture no longer records past the clip, so a clip marked to the end of
	 * the song ("end where the music ends") needs no special handling beyond this:
	 * screencast frames start only once the page has painted, so there is no
	 * pre-paint head to trim and therefore no slack to record.
	 */
	const trackSeconds = await probeDuration(sourceMp3)
	const runsToEnd = trackSeconds - clip.endMs / 1000 < TRACK_END_TOLERANCE_SECONDS

	step(`on air @${(clip.startMs / 1000).toFixed(1)}s`)
	await playAt(filename, clip.startMs)
	await new Promise(resolve => setTimeout(resolve, ON_AIR_SETTLE_MS))

	const captureDir = path.join(workDir, 'capture')
	await mkdir(captureDir, { recursive: true })
	// Capture is real time, so say how long this will actually take.
	step(`capturing ${durationSeconds.toFixed(0)}s (real time)`)
	const rawVideo = await captureVideo(captureDir, durationSeconds)

	/**
	 * Confirm the station never moved off this track mid-capture.
	 *
	 * The video shows whatever the PAGE says is playing, while the audio is cut
	 * from this clip's own MP3 — so if the station advanced (a stalled render, a
	 * track ending, someone else driving the DJ tab), the result is a silent
	 * mismatch: the wrong cover art over the right audio. Observed in testing,
	 * where a wedged render left the station several tracks along.
	 *
	 * Skipped for a clip that runs to the end of the track: there the handoff is
	 * the natural end of the song, it happens after the clip's own content is
	 * already captured, and the trimmed-off tail is the only part that could show
	 * the next track.
	 */
	if (!runsToEnd) {
		const stillOnAir = await nowPlayingPath()
		if (stillOnAir !== null && path.basename(stillOnAir) !== filename) {
			throw new Error(
				`station moved to ${path.basename(stillOnAir)} during capture — ` +
					'the recorded video would show the wrong track',
			)
		}
	}

	/**
	 * Cut the audio from the source file.
	 *
	 * `-c copy` snaps to frame boundaries, so this can overshoot by a few tens of
	 * milliseconds; `-t` on the mux below truncates to the exact length. Keeping
	 * the copy (rather than re-encoding here) avoids a generational loss.
	 */
	step('cutting audio')
	const audioSlice = path.join(workDir, 'audio.mp3')
	await run('ffmpeg', [
		'-v',
		'error',
		'-y',
		'-ss',
		String(clip.startMs / 1000),
		'-to',
		String(clip.endMs / 1000),
		'-i',
		sourceMp3,
		'-c',
		'copy',
		audioSlice,
	])

	// A clip marked past the end of the track yields a short or empty slice. The
	// DJ tab flags these with a ⚠ badge; catch them here too, since a batch run
	// is unattended.
	const audioDuration = await probeDuration(audioSlice)
	if (audioDuration < durationSeconds - 0.5) {
		throw new Error(
			`audio slice is ${audioDuration.toFixed(2)}s but the clip asks for ${durationSeconds.toFixed(2)}s — ` +
				'the clip likely runs past the end of the track',
		)
	}

	/**
	 * Fade out the last seconds of both streams.
	 *
	 * Timestamps are relative to the TRIMMED output, not the source files: `-ss`
	 * on the video input and `-ss` on the audio cut both reset the clock to zero,
	 * so the fade starts at `durationSeconds - fade` in filter time.
	 *
	 * `afade` needs an explicit duration (`d`) rather than inheriting one, and
	 * `fade=t=out` needs `st`+`d` for the same reason.
	 */
	step('encoding')
	const fade = Math.min(FADE_SECONDS, durationSeconds / 2)
	const fadeStart = durationSeconds - fade

	/**
	 * Tolerate an encode that finishes its file but never reports exit.
	 *
	 * Observed repeatedly in testing: ffmpeg writes a complete, valid MP4 and then
	 * lingers as a zombie, so `close` never fires and `run()` eventually times it
	 * out. Failing the clip there would throw away a perfectly good render, so the
	 * timeout is treated as inconclusive — the verification below is what actually
	 * decides, and it rejects a truncated or silent file anyway. Any other error is
	 * still fatal.
	 */
	const encode = run('ffmpeg', [
		'-v',
		'error',
		'-y',
		'-i',
		rawVideo,
		'-i',
		audioSlice,
		'-map',
		'0:v',
		'-map',
		'1:a',
		'-vf',
		`fade=t=out:st=${fadeStart}:d=${fade}`,
		'-af',
		`afade=t=out:st=${fadeStart}:d=${fade}`,
		'-c:v',
		'libx264',
		'-preset',
		'slow',
		'-crf',
		'19',
		'-pix_fmt',
		'yuv420p', // required for playback on basically every social platform
		'-r',
		String(FPS),
		'-c:a',
		'aac',
		'-b:a',
		'192k',
		'-t',
		String(durationSeconds),
		'-movflags',
		'+faststart',
		outputPath,
	])
	try {
		await encode
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (!message.includes('did not finish within')) throw error
		if (!(await exists(outputPath))) throw error
		console.log('    (encoder did not report exit; falling through to verification)')
	}

	step('verifying')
	// Verify what we actually produced rather than trusting a zero exit code: a
	// silent or short render is the failure mode that would otherwise reach the
	// editor unnoticed.
	const finalDuration = await probeDuration(outputPath)
	if (Math.abs(finalDuration - durationSeconds) > 0.5) {
		throw new Error(`rendered ${finalDuration.toFixed(2)}s, expected ${durationSeconds.toFixed(2)}s`)
	}

	/**
	 * Confirm the audio is actually audible, not just present.
	 *
	 * `-f null -` sends the null muxer's output to stdout, so both pipes are drained
	 * in `run()`. The report itself goes to stderr. Reading `mean_volume` catches the
	 * real failure — a track of digital silence, which has a valid AAC stream and a
	 * correct duration and would otherwise pass every other check here.
	 */
	const { stderr } = await run('ffmpeg', [
		'-hide_banner',
		'-i',
		outputPath,
		'-map',
		'0:a',
		'-af',
		'volumedetect',
		'-f',
		'null',
		'-',
	])
	const meanVolume = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr)
	if (!meanVolume) {
		throw new Error('could not measure the rendered audio (no volumedetect report)')
	}
	// Digital silence reports -91 dB; anything quieter than -80 has no usable signal.
	if (Number(meanVolume[1]) < -80) {
		throw new Error(`rendered file has no audible audio (mean ${meanVolume[1]} dB)`)
	}
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
	track?: string
	clipId?: string
	dryRun: boolean
}

function parseArgs(argv: string[]): Options {
	const options: Options = { dryRun: false }
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]
		if (arg === '--dry-run') options.dryRun = true
		else if (arg === '--track') options.track = argv[++index]
		else if (arg === '--clip') options.clipId = argv[++index]
		else throw new Error(`unknown argument: ${arg}`)
	}
	return options
}

function buildJobs(clips: Record<string, Clip[]>, options: Options): RenderJob[] {
	const jobs: RenderJob[] = []
	for (const [filename, trackClips] of Object.entries(clips)) {
		if (options.track && filename !== options.track) continue
		for (const clip of trackClips) {
			if (options.clipId && clip.id !== options.clipId) continue
			const durationSeconds = (clip.endMs - clip.startMs) / 1000
			if (durationSeconds <= 0) {
				console.warn(`  skipping ${filename} clip ${clip.id}: endMs is not after startMs`)
				continue
			}
			const name = `${slugify(filename)}-${clip.id}-${WIDTH}x${HEIGHT}.mp4`
			jobs.push({ filename, clip, outputPath: path.join(OUTPUT_DIR, name), durationSeconds })
		}
	}
	return jobs
}

/**
 * Fail fast on a broken environment, before spending real-time captures on it.
 *
 * Each of these cost a wasted run at some point during this workflow's testing:
 * ffmpeg missing from PATH, the site not running, and — the quiet one — a
 * Playwright install with only `chromium_headless_shell`, which cannot record
 * video and fails at launch rather than at install.
 */
async function preflight(): Promise<void> {
	for (const binary of ['ffmpeg', 'ffprobe']) {
		try {
			await run(binary, ['-version'])
		} catch {
			throw new Error(`${binary} is not on PATH — it is needed to cut and mux the clip`)
		}
	}

	try {
		const response = await fetch(`${SITE_URL}/en/radio/?${PAGE_FLAGS}`)
		if (!response.ok) throw new Error(String(response.status))
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new Error(`the site at ${SITE_URL} is not reachable (${detail}) — it is the page being filmed`)
	}

	/**
	 * Check the radio too, not just the site. They are separate servers, and when
	 * only the radio was down the site check still passed -- the run then failed
	 * with a bare connection error naming the site URL, which pointed diagnosis at
	 * the wrong service. Every render drives this server to put a track on air.
	 */
	try {
		const response = await fetch(`${RADIO_URL}/status`)
		if (!response.ok) throw new Error(String(response.status))
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new Error(
			`the radio server at ${RADIO_URL} is not reachable (${detail}) — ` +
				'it supplies the audio and is what each render puts on air',
		)
	}

	/**
	 * Check that the recording browser is installed, WITHOUT launching it.
	 *
	 * A probe launch here used to verify the channel end to end, but launching a
	 * browser and closing it *poisons the next one in the same process*: the capture
	 * browser then dies partway through, its screencast stops delivering frames, and
	 * the render silently becomes a 48-byte file. Reproduced deterministically --
	 * frames received froze at 163 of 210 with the probe present and ran to
	 * completion without it. Playwright does not fully reset between browser
	 * instances, which is the same shape as the `recordVideo` deadlock this pipeline
	 * replaced. So: check the file on disk, and let the real launch be the first.
	 */
	const { chromium } = await import('playwright')
	const executable = chromium.executablePath()
	if (!(await exists(executable))) {
		throw new Error(
			`the Chromium build Playwright expects is missing (${executable}). ` +
				'Install it with `npx playwright install chromium`.',
		)
	}
}

/**
 * Render one clip in a fresh child process, streaming its progress through.
 *
 * Re-invokes this same script with `--clip`, which is the path proven to work in
 * isolation. The child's exit code is the result; its stdout is echoed so a batch
 * still reads as one continuous log.
 */
function renderInChild(clipId: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [process.argv[1] as string, '--clip', clipId], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: process.env,
		})
		let stderr = ''
		// Only the per-stage "… step" lines matter here; the child repeats the
		// header and summary that the parent already prints.
		child.stdout.on('data', chunk => {
			for (const line of String(chunk).split('\n')) {
				if (line.startsWith('  … ')) console.log(line)
			}
		})
		child.stderr.on('data', chunk => {
			stderr += String(chunk)
		})
		child.on('error', reject)
		child.on('close', code => {
			if (code === 0) {
				resolve()
				return
			}
			// The child prints its own "  ✗ <reason>"; surface that rather than a
			// bare exit code, falling back to stderr when it died without one.
			const reported = /^ {2}✗ (.+)$/m.exec(stderr)
			reject(new Error(reported?.[1] ?? stderr.trim() ?? `child exited ${code}`))
		})
	})
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2))

	if (!API_KEY) {
		console.error('RADIO_API_KEY is not set — every DJ and clip route is admin-gated.')
		process.exit(1)
	}

	// This script reaches into the live broadcast. Refuse to point it anywhere but
	// a local server, where the only listener is the person recording.
	const host = new URL(RADIO_URL).hostname
	if (host !== 'localhost' && host !== '127.0.0.1') {
		console.error(
			`Refusing to run against ${RADIO_URL}.\n` +
				'The DJ routes change what every connected listener hears; this is local-only.',
		)
		process.exit(1)
	}

	const clips = await fetchClips()
	const jobs = buildJobs(clips, options)

	if (jobs.length === 0) {
		console.log('No clips matched. Mark some in the DJ tab first.')
		return
	}

	console.log(`${jobs.length} clip(s) to render:`)
	for (const job of jobs) {
		const label = job.clip.label ? ` "${job.clip.label}"` : ''
		console.log(
			`  ${job.filename} [${job.clip.id}]${label} ${job.durationSeconds.toFixed(1)}s -> ${job.outputPath}`,
		)
	}
	/**
	 * Captures run in real time, so a batch takes at least the sum of its clips.
	 * Saying so upfront is what separates "still working" from "wedged" when the
	 * run goes quiet — the distinction that cost real time during testing.
	 */
	const captureSeconds = jobs.reduce((total, job) => total + job.durationSeconds + SETUP_SECONDS, 0)
	console.log(`\n~${Math.ceil(captureSeconds / 60)} min of capture, plus encoding.`)

	if (options.dryRun) return

	await preflight()

	await mkdir(OUTPUT_DIR, { recursive: true })

	/**
	 * A single `--clip` run does the work in-process; a multi-clip batch fans out
	 * to one child per clip. Captures do not survive being run back-to-back in one
	 * process: clips 1 and 2 render and the THIRD hangs with its browser dead and
	 * no open handles, reproducibly, while that same clip renders fine on its own.
	 * Something accumulates in the Playwright client across captures (the same
	 * shape as the `recordVideo` deadlock this pipeline replaced, one position
	 * later). A fresh process per clip makes every capture the first one.
	 */
	if (jobs.length === 1 && jobs[0] !== undefined) {
		const job = jobs[0]
		const workDir = path.join(OUTPUT_DIR, `.work-${job.clip.id}`)
		await rm(workDir, { recursive: true, force: true })
		await mkdir(workDir, { recursive: true })
		try {
			await renderClip(job, workDir, message => console.log(`  … ${message}`))
			console.log(`  ✓ ${job.outputPath}`)
			console.log('\nDone: 1 rendered, 0 failed.')
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			console.error(`  ✗ ${message}`)
			console.log('\nDone: 0 rendered, 1 failed.')
			process.exitCode = 1
		} finally {
			await rm(workDir, { recursive: true, force: true })
		}
		return
	}

	const results: RenderResult[] = []
	for (const [index, job] of jobs.entries()) {
		console.log(`\n[${index + 1}/${jobs.length}] ${job.filename} [${job.clip.id}]`)
		try {
			// `--clip` renders exactly this one, so the child does the work below.
			await renderInChild(job.clip.id)
			console.log(`  ✓ ${job.outputPath}`)
			results.push({ job, ok: true })
		} catch (error) {
			// One bad clip should not abandon the rest of the batch.
			const message = error instanceof Error ? error.message : String(error)
			console.error(`  ✗ ${message}`)
			results.push({ job, ok: false, error: message })
		}
	}

	const failed = results.filter(result => !result.ok)
	console.log(`\nDone: ${results.length - failed.length} rendered, ${failed.length} failed.`)
	for (const failure of failed) {
		console.log(`  ✗ ${failure.job.filename} [${failure.job.clip.id}]: ${failure.error}`)
	}
	if (failed.length > 0) process.exit(1)
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error)
	process.exit(1)
})
