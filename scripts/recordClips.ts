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
import { access, mkdir, readdir, rm, stat } from 'node:fs/promises'
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
 * Recorded seconds of slack beyond the clip length, trimmed off after the fact.
 *
 * Playwright starts recording when the CONTEXT is created, not when the page has
 * painted, so every capture opens with a stretch of empty background and an
 * unloaded cover box. Measured at 4.4s and 5.08s on two runs of the same page —
 * it varies with image fetches and dev-server warmth, so it must be measured per
 * recording, never hardcoded. We record with this much extra and cut the real
 * lead-in off using the finished file's own duration.
 */
const HANDLE_SECONDS = 4

/** The page is visually static, but give the glow/drift a moment to settle. */
const SETTLE_MS = 1500

/** A cover that never loads leaves a blank square in frame — fail instead. */
const CONTENT_TIMEOUT_MS = 15_000

/** Ceiling on the initial navigation; the page is local, so this is generous. */
const NAVIGATION_TIMEOUT_MS = 30_000

/** The radio needs a moment to actually be streaming the new position. */
const ON_AIR_SETTLE_MS = 1200

/**
 * Ceiling on `context.close()`, which finalizes the recorded video.
 *
 * Playwright's video encoder can deadlock (see `captureVideo`), and the close
 * then never returns. A healthy close takes well under a second even for a 60s
 * capture, so 60s is generous; the point is only that a wedged render fails
 * instead of hanging an unattended batch forever.
 */
const CLOSE_TIMEOUT_MS = 60_000

/**
 * Ceiling on the whole in-browser phase: navigate, await artwork, play, hold for
 * the capture, finalize.
 *
 * `CLOSE_TIMEOUT_MS` alone is not enough. Every await in that phase is a protocol
 * round-trip to the browser, so when the capture encoder wedges, the *page* stops
 * responding and the script hangs at whichever call it happens to be in — observed
 * in a 15-clip batch stalling 29 minutes inside `page.waitForTimeout`, well before
 * `context.close()` was ever reached. Bounding only the close guards one point on
 * a path where any point can hang; this bounds the path.
 */
const CAPTURE_TIMEOUT_MS = 90_000

/**
 * Ceiling on browser teardown. `browser.close()` is itself a protocol call, so the
 * very deadlock this recovers from can hang the recovery; past it we SIGKILL.
 */
const TEARDOWN_TIMEOUT_MS = 15_000

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
		timer.unref?.()

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
 * capture, that is `browser.close()` in the `finally`). The timer is unref'd so a
 * pending one cannot by itself keep the process alive.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms)
		timer.unref?.()
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
 * Last-resort teardown for a browser that will not close.
 *
 * `browser.close()` is a protocol call, so the deadlock it is meant to recover from
 * can hang the recovery itself, and Playwright's `Browser` exposes no pid
 * (`process()` is on `BrowserServer`; `launchServer` + `connect` fails under Bun's
 * ws client). The capture directory is not in the browser's argv either -- the
 * encoder is fed over `pipe:0` -- so the processes are matched by the browser
 * binary path Playwright launched, restricted to children of this process so a
 * concurrent run or an unrelated Chromium is never touched.
 */
async function killStuckCapture(): Promise<void> {
	const { chromium } = await import('playwright')
	// The installed-browsers root, e.g. ~/.cache/ms-playwright -- shared by the
	// browser build and the bundled ffmpeg that encodes the capture.
	const browsersRoot = path.dirname(path.dirname(path.dirname(chromium.executablePath())))
	try {
		const { stdout } = await run('pgrep', ['-f', browsersRoot], 10_000)
		const pids = stdout
			.split('\n')
			.map(line => Number(line.trim()))
			.filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
		for (const pid of await ownDescendants(pids)) {
			try {
				process.kill(pid, 'SIGKILL')
			} catch {
				// Already gone; nothing to reap.
			}
		}
	} catch {
		// pgrep exits 1 when nothing matches, which is the good case.
	}
}

/**
 * Narrow `pids` to those descended from this process, so killing a wedged capture
 * cannot take down a browser this script did not start.
 */
async function ownDescendants(pids: number[]): Promise<number[]> {
	if (pids.length === 0) return []
	const parents = new Map<number, number>()
	try {
		const { stdout } = await run('ps', ['-eo', 'pid=,ppid='], 10_000)
		for (const line of stdout.split('\n')) {
			const fields = line.trim().split(/\s+/)
			if (fields.length < 2) continue
			const pid = Number(fields[0])
			const ppid = Number(fields[1])
			if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid, ppid)
		}
	} catch {
		// Without the process table there is no safe way to attribute these.
		return []
	}
	const isOurs = (pid: number): boolean => {
		// Walk up to init; stop on a cycle or a pid that has left the table.
		for (let current = pid, hops = 0; hops < 64; hops++) {
			const parent = parents.get(current)
			if (parent === undefined || parent <= 1) return false
			if (parent === process.pid) return true
			current = parent
		}
		return false
	}
	return pids.filter(isOurs)
}

/**
 * Record the page for `seconds`, returning the path to the raw silent video.
 *
 * Playwright's own video file is written on `context.close()`, so the path is only
 * available after the context is gone.
 */
async function captureVideo(outDir: string, seconds: number): Promise<string> {
	// Imported lazily so `--dry-run` and `--help` work without Playwright installed.
	const { chromium } = await import('playwright')

	/**
	 * `channel: 'chromium'` is load-bearing, not cosmetic. A bare `chromium.launch()`
	 * starts `chromium_headless_shell`, which cannot record video: it produces a
	 * 0-byte .webm and leaves its encoder blocked on `pipe:0`, which then deadlocks
	 * `context.close()`. That was the "intermittent encoder flake" seen throughout
	 * this workflow's testing. Only this channel selects the full browser.
	 */
	const browser = await chromium.launch({ channel: 'chromium' })
	const context = await browser.newContext({
		viewport: { width: WIDTH, height: HEIGHT },
		recordVideo: { dir: outDir, size: { width: WIDTH, height: HEIGHT } },
		deviceScaleFactor: 1,
	})

	/**
	 * The Astro dev toolbar injects a floating dark pill at the bottom of the
	 * viewport. It lives outside the page's own DOM, so `?stage` cannot hide it,
	 * and it sits squarely in frame on a 1080x1920 capture.
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

	try {
		/**
		 * The entire browser phase runs under one deadline. A wedged encoder makes
		 * the page unresponsive, and then *any* of these awaits can hang forever --
		 * they are all protocol round-trips, not local sleeps. The timeout rejects
		 * this promise while the hung call stays pending in the background; the
		 * `finally` below is what actually kills it.
		 */
		const capture = async (): Promise<void> => {
			const page = await context.newPage()
			/**
			 * `domcontentloaded`, not `networkidle`. The radio page holds an SSE
			 * metadata stream and an audio stream open by design, so the network never
			 * reliably goes quiet for the 500ms `networkidle` requires -- it only
			 * passes when those happen to lull, and it timed out on two clips of a
			 * 15-clip batch. Readiness for the shot is established below by waiting on
			 * the artwork itself, which is the thing that must actually be painted.
			 */
			await page.goto(`${SITE_URL}/en/radio/?${PAGE_FLAGS}`, {
				waitUntil: 'domcontentloaded',
				timeout: NAVIGATION_TIMEOUT_MS,
			})

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

			await page.waitForTimeout(seconds * 1000)

			/**
			 * `context.close()` flushes and finalizes the video, so the file only
			 * exists after it returns -- and it can hang forever. Playwright's ffmpeg
			 * encoder has been seen blocked reading `pipe:0` with a 0-byte .webm,
			 * never returning. It is intermittent (the same clip renders fine on a
			 * retry), so it cannot be avoided by validating inputs. Its own bound is
			 * kept under the outer one so a close-specific stall still names itself.
			 */
			await withTimeout(
				context.close(),
				CLOSE_TIMEOUT_MS,
				`Playwright did not finalize the video within ${CLOSE_TIMEOUT_MS / 1000}s ` +
					'(the encoder can deadlock; this render is lost, the batch continues)',
			)
		}

		await withTimeout(
			capture(),
			CAPTURE_TIMEOUT_MS,
			`Playwright did not finish the capture within ${CAPTURE_TIMEOUT_MS / 1000}s ` +
				'(the encoder can deadlock and freeze the page; this render is lost, the batch continues)',
		)

		// Playwright names the file itself; the directory is per-render, so the
		// single .webm in it is ours.
		const entries = await readdir(outDir)
		const video = entries.find(entry => entry.endsWith('.webm'))
		if (!video) throw new Error(`Playwright wrote no video into ${outDir}`)

		// A deadlocked encoder leaves the file present but empty, so existence alone
		// is not proof of a capture.
		const videoPath = path.join(outDir, video)
		const { size } = await stat(videoPath)
		if (size === 0) throw new Error('Playwright wrote a 0-byte video (encoder produced no frames)')

		return videoPath
	} finally {
		/**
		 * Always reachable, including after a timeout above -- this is what tears
		 * down the stuck browser and its encoder so the next clip can run.
		 *
		 * `browser.close()` is itself a protocol call, so a deadlock deep enough to
		 * trip the timeouts above can hang the cleanup too. Bound it, then SIGKILL
		 * the process outright: leaking a wedged Chromium would leave the encoder
		 * holding the capture directory and poison every remaining clip.
		 */
		try {
			await withTimeout(browser.close(), TEARDOWN_TIMEOUT_MS, 'browser teardown timed out')
		} catch {
			await killStuckCapture()
		}
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

	step(`on air @${(clip.startMs / 1000).toFixed(1)}s`)
	await playAt(filename, clip.startMs)
	await new Promise(resolve => setTimeout(resolve, ON_AIR_SETTLE_MS))

	const captureDir = path.join(workDir, 'capture')
	await mkdir(captureDir, { recursive: true })
	// Capture is real time, so say how long this will actually take.
	step(`capturing ${(durationSeconds + HANDLE_SECONDS).toFixed(0)}s (real time)`)
	const rawVideo = await captureVideo(captureDir, durationSeconds + HANDLE_SECONDS)

	/**
	 * Confirm the station never moved off this track mid-capture.
	 *
	 * The video shows whatever the PAGE says is playing, while the audio is cut
	 * from this clip's own MP3 — so if the station advanced (a stalled render, a
	 * track ending, someone else driving the DJ tab), the result is a silent
	 * mismatch: the wrong cover art over the right audio. Observed in testing,
	 * where a wedged render left the station several tracks along.
	 */
	const stillOnAir = await nowPlayingPath()
	if (stillOnAir !== null && path.basename(stillOnAir) !== filename) {
		throw new Error(
			`station moved to ${path.basename(stillOnAir)} during capture — ` +
				'the recorded video would show the wrong track',
		)
	}

	/**
	 * Measure the pre-paint lead-in rather than assuming it.
	 *
	 * We waited `duration + HANDLE` seconds after the page had settled, so
	 * everything in the file beyond that is the unpainted head. Using the file's
	 * own duration means a slow image fetch shifts the trim automatically.
	 */
	const rawDuration = await probeDuration(rawVideo)
	const leadIn = Math.max(0, rawDuration - (durationSeconds + HANDLE_SECONDS))

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
		'-ss',
		String(leadIn),
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
	 * Verify the recording browser by launching it, not by inspecting
	 * `chromium.executablePath()`.
	 *
	 * That path reports the full Chromium even when `launch()` would actually start
	 * `chromium_headless_shell` -- so the old check passed while the real capture ran
	 * on the binary that cannot record. Launching the exact channel the capture uses
	 * is the only check that cannot drift from it.
	 */
	const { chromium } = await import('playwright')
	try {
		const probe = await chromium.launch({ channel: 'chromium' })
		await probe.close()
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new Error(
			`could not launch the "chromium" channel, which is the only build that records video (${detail}). ` +
				'Install it with `npx playwright install chromium`.',
		)
	}
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
	const captureSeconds = jobs.reduce((total, job) => total + job.durationSeconds + HANDLE_SECONDS, 0)
	console.log(`\n~${Math.ceil(captureSeconds / 60)} min of capture, plus encoding.`)

	if (options.dryRun) return

	await preflight()

	await mkdir(OUTPUT_DIR, { recursive: true })

	const results: RenderResult[] = []
	for (const [index, job] of jobs.entries()) {
		console.log(`\n[${index + 1}/${jobs.length}] ${job.filename} [${job.clip.id}]`)
		// Per-render scratch, so a crashed run cannot leave a stale .webm that the
		// next render would pick up as its own.
		const workDir = path.join(OUTPUT_DIR, `.work-${job.clip.id}`)
		await rm(workDir, { recursive: true, force: true })
		await mkdir(workDir, { recursive: true })
		try {
			await renderClip(job, workDir, message => console.log(`  … ${message}`))
			console.log(`  ✓ ${job.outputPath}`)
			results.push({ job, ok: true })
		} catch (error) {
			// One bad clip should not abandon the rest of the batch.
			const message = error instanceof Error ? error.message : String(error)
			console.error(`  ✗ ${message}`)
			results.push({ job, ok: false, error: message })
		} finally {
			await rm(workDir, { recursive: true, force: true })
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
