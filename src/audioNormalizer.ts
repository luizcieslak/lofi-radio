/**
 * AUDIO NORMALIZER
 * ================
 *
 * Normalizes uploaded MP3s to one canonical output format so the engine can
 * concatenate frames from every track into a SINGLE browser decode session
 * without a midstream sample-rate change.
 *
 * Background: the stream is one continuous `audio/mpeg` body decoded by a single
 * decoder. A heterogeneous library (some tracks 44100 Hz, others 48000 Hz)
 * makes the browser throw a hard, unrecoverable `MediaError` at the track
 * boundary where the rate changes (Chrome `PIPELINE_ERROR_DECODE`, Firefox
 * `NS_ERROR_DOM_MEDIA_DECODE_ERR`), heard as a gap/stutter while the player
 * tears down and reconnects. Normalizing every track to 44100 Hz / stereo /
 * MPEG1 Layer III removes the boundary mismatch entirely.
 *
 * Canonical target (matches the offline batch normalizer in
 * ~/clawd/lofi-radio-tools): 44100 Hz, stereo, libmp3lame VBR V0 (-q:a 0).
 * We re-encode ONLY files whose sample rate differs from the target, so
 * already-canonical uploads are left bit-for-bit untouched (no needless
 * generational lossy loss).
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const TARGET_SAMPLE_RATE = 44100
export const TARGET_CHANNELS = 2

// Binaries are on PATH locally (linuxbrew) and in the prod Docker image
// (apt-get install ffmpeg). Overridable for unusual environments.
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'

/**
 * Outcome of {@link normalizeInPlace}. Modeled as a discriminated union so the
 * impossible combinations (e.g. re-encoded *and* errored) can't be represented.
 * - `unchanged`: file was already canonical; left untouched.
 * - `normalized`: file was re-encoded in place to the canonical format.
 * - `failed`: could not probe or re-encode; the ORIGINAL file is kept intact.
 */
export type NormalizeResult =
	| { status: 'unchanged'; sourceSampleRate: number }
	| { status: 'normalized'; sourceSampleRate: number }
	| { status: 'failed'; sourceSampleRate: number | null; error: string }

/**
 * Pure: decide whether a probed sample rate requires re-encoding.
 */
export function needsNormalization(sampleRate: number): boolean {
	return sampleRate !== TARGET_SAMPLE_RATE
}

/**
 * Pure: build the ffmpeg argument vector that transcodes `input` to the
 * canonical format at `output`.
 *
 * - `-map 0:a` keeps the audio; `-map 0:v?` keeps an embedded cover if present
 *   (the `?` makes it optional so coverless files don't fail) and `-c:v copy`
 *   passes it through without re-encoding.
 * - `-map_metadata 0 -id3v2_version 3` preserves ID3 tags.
 * - libmp3lame `-q:a 0` is VBR V0 (~245 kbps), transparent for these lossy
 *   ~160-283 kbps sources without wasteful bloat.
 */
export function buildNormalizeArgs(input: string, output: string): string[] {
	return [
		'-i',
		input,
		'-map',
		'0:a',
		'-map',
		'0:v?',
		'-c:v',
		'copy',
		'-ar',
		String(TARGET_SAMPLE_RATE),
		'-ac',
		String(TARGET_CHANNELS),
		'-c:a',
		'libmp3lame',
		'-q:a',
		'0',
		'-map_metadata',
		'0',
		'-id3v2_version',
		'3',
		'-y',
		output,
	]
}

interface SpawnResult {
	code: number | null
	stdout: string
	stderr: string
}

/**
 * Run a binary with an explicit argument array (never a shell string, so
 * filenames with spaces / unicode are safe). Resolves with exit code + output;
 * rejects only if the binary can't be spawned at all.
 */
function run(bin: string, args: string[]): Promise<SpawnResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args)
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', chunk => {
			stdout += chunk
		})
		child.stderr.on('data', chunk => {
			stderr += chunk
		})
		child.on('error', reject)
		child.on('close', code => resolve({ code, stdout, stderr }))
	})
}

/**
 * Probe a file's first audio stream sample rate. Returns null if the file
 * can't be probed (missing, not audio, corrupt).
 */
export async function probeSampleRate(filepath: string): Promise<number | null> {
	try {
		const { code, stdout } = await run(FFPROBE, [
			'-v',
			'error',
			'-select_streams',
			'a:0',
			'-show_entries',
			'stream=sample_rate',
			'-of',
			'csv=p=0',
			filepath,
		])
		if (code !== 0) return null
		const rate = Number.parseInt(stdout.trim(), 10)
		return Number.isFinite(rate) && rate > 0 ? rate : null
	} catch {
		return null
	}
}

/**
 * Normalize a file in place if its sample rate differs from the canonical
 * target. No-op (returns `normalized: false`) when the file is already
 * canonical or can't be probed.
 *
 * Safety: the re-encode goes to a temp file in the SAME directory (so the
 * final `rename` stays on one filesystem — no EXDEV) and only replaces the
 * original after ffprobe confirms the output is actually at the target rate.
 * On any failure the original file is left untouched so an upload is never lost.
 */
export async function normalizeInPlace(filepath: string): Promise<NormalizeResult> {
	const sourceSampleRate = await probeSampleRate(filepath)

	if (sourceSampleRate === null) {
		return { status: 'failed', sourceSampleRate: null, error: 'Could not probe sample rate' }
	}

	if (!needsNormalization(sourceSampleRate)) {
		return { status: 'unchanged', sourceSampleRate }
	}

	// Unique per call (randomUUID) so concurrent uploads of the same filename
	// can't collide on the temp path — `process.pid` is constant in this
	// single, long-lived server process and gives no per-upload uniqueness.
	const dir = path.dirname(filepath)
	const tmp = path.join(dir, `.normalizing-${path.basename(filepath)}.${randomUUID()}.tmp.mp3`)

	try {
		const { code, stderr } = await run(FFMPEG, buildNormalizeArgs(filepath, tmp))
		if (code !== 0) {
			throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)
		}

		const outRate = await probeSampleRate(tmp)
		if (outRate !== TARGET_SAMPLE_RATE) {
			throw new Error(`output sample rate is ${outRate}, expected ${TARGET_SAMPLE_RATE}`)
		}

		fs.renameSync(tmp, filepath)
		return { status: 'normalized', sourceSampleRate }
	} catch (err) {
		// Keep the original file; clean up the partial temp.
		try {
			if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
		} catch {
			// best effort
		}
		return {
			status: 'failed',
			sourceSampleRate,
			error: err instanceof Error ? err.message : String(err),
		}
	}
}
