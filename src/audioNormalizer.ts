/**
 * AUDIO NORMALIZER
 * ================
 *
 * Normalizes uploaded MP3s to one canonical output format so the engine can
 * concatenate frames from every track into a SINGLE browser decode session
 * without a midstream sample-rate change, AND so listeners don't hear a jump in
 * perceived volume between tracks.
 *
 * Background: the stream is one continuous `audio/mpeg` body decoded by a single
 * decoder. A heterogeneous library (some tracks 44100 Hz, others 48000 Hz)
 * makes the browser throw a hard, unrecoverable `MediaError` at the track
 * boundary where the rate changes (Chrome `PIPELINE_ERROR_DECODE`, Firefox
 * `NS_ERROR_DOM_MEDIA_DECODE_ERR`), heard as a gap/stutter while the player
 * tears down and reconnects. Normalizing every track to 44100 Hz / stereo /
 * MPEG1 Layer III removes the boundary mismatch entirely.
 *
 * Two normalizations, applied in ONE re-encode (a single generational loss):
 *  1. Format → 44100 Hz, stereo, libmp3lame VBR V0 (-q:a 0).
 *  2. Loudness → EBU R128 to -14 LUFS / -1 dBTP / 11 LU (streaming standard),
 *     via two-pass loudnorm (measure, then apply the measured values) for
 *     accuracy, with a single-pass fallback if measurement fails.
 *
 * We re-encode only when a file is actually off-target — wrong sample rate OR
 * loudness more than {@link LOUDNESS_TOLERANCE_LU} from target — so re-uploading
 * an already-canonical, already-loud-matched track is left bit-for-bit untouched
 * (no needless generational lossy loss). Matches the offline batch tools in
 * ~/clawd/lofi-radio-tools (normalize-tracks.ts + normalize-volume.ts).
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const TARGET_SAMPLE_RATE = 44100
export const TARGET_CHANNELS = 2

// Loudness target (EBU R128). -14 LUFS integrated is the Spotify/YouTube/Tidal
// standard; -1 dBTP true-peak ceiling; 11 LU loudness range.
export const TARGET_I = -14
export const TARGET_TP = -1
export const TARGET_LRA = 11

// A file already within this many LU of target (and at the canonical rate) is
// left untouched, so re-uploading an already-normalized track doesn't incur a
// needless generational re-encode.
export const LOUDNESS_TOLERANCE_LU = 1.0

// Binaries are on PATH locally (linuxbrew) and in the prod Docker image
// (apt-get install ffmpeg). Overridable for unusual environments.
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'

/**
 * Outcome of {@link normalizeInPlace}. Modeled as a discriminated union so the
 * impossible combinations (e.g. re-encoded *and* errored) can't be represented.
 * - `unchanged`: file was already canonical (rate + loudness); left untouched.
 * - `normalized`: file was re-encoded in place to the canonical format/loudness.
 * - `failed`: could not probe or re-encode; the ORIGINAL file is kept intact.
 *
 * `sourceLoudnessLufs` is the measured integrated loudness of the input, or
 * null if it couldn't be measured.
 */
export type NormalizeResult =
	| { status: 'unchanged'; sourceSampleRate: number; sourceLoudnessLufs: number | null }
	| { status: 'normalized'; sourceSampleRate: number; sourceLoudnessLufs: number | null }
	| { status: 'failed'; sourceSampleRate: number | null; error: string }

/**
 * Measured loudness stats from a loudnorm analysis pass, fed back into the
 * apply pass for accurate two-pass normalization.
 */
export interface LoudnessStats {
	input_i: string
	input_tp: string
	input_lra: string
	input_thresh: string
	target_offset: string
}

/**
 * Pure: decide whether a file requires re-encoding. True when the sample rate
 * is off-target OR the integrated loudness is more than the tolerance from the
 * target. (Callers handle the "loudness unmeasurable" case separately.)
 */
export function needsNormalization(sampleRate: number, integratedLoudnessLufs: number): boolean {
	if (sampleRate !== TARGET_SAMPLE_RATE) return true
	return Math.abs(integratedLoudnessLufs - TARGET_I) > LOUDNESS_TOLERANCE_LU
}

/**
 * Pure: build the loudnorm filter string. With `stats` it runs in two-pass mode
 * (`measured_*` + `offset` + `linear=true`, which applies a single transparent
 * linear gain when it can hit target without clipping). Without `stats` it runs
 * single-pass/dynamic — the fallback when analysis failed.
 */
export function buildLoudnormFilter(stats: LoudnessStats | null): string {
	const base = `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}`
	if (stats === null) return base
	return (
		`${base}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}` +
		`:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}` +
		`:offset=${stats.target_offset}:linear=true`
	)
}

/**
 * Pure: build the ffmpeg arg vector for the loudnorm ANALYSIS pass (pass 1).
 * Decodes audio through loudnorm with JSON output and writes nothing (null
 * muxer) — runs faster than realtime.
 */
export function buildMeasureArgs(input: string): string[] {
	return [
		'-hide_banner',
		'-i',
		input,
		'-map',
		'0:a',
		'-af',
		`${buildLoudnormFilter(null)}:print_format=json`,
		'-f',
		'null',
		'-',
	]
}

/**
 * Pure: build the ffmpeg argument vector that transcodes `input` to the
 * canonical format + loudness at `output`.
 *
 * - `-af loudnorm…` normalizes loudness (two-pass when `stats` is provided).
 * - `-map 0:a` keeps the audio; `-map 0:v?` keeps an embedded cover if present
 *   (the `?` makes it optional so coverless files don't fail) and `-c:v copy`
 *   passes it through without re-encoding.
 * - `-map_metadata 0 -id3v2_version 3` preserves ID3 tags.
 * - libmp3lame `-q:a 0` is VBR V0 (~245 kbps), transparent for these lossy
 *   ~160-283 kbps sources without wasteful bloat.
 */
export function buildNormalizeArgs(input: string, output: string, stats: LoudnessStats | null): string[] {
	return [
		'-i',
		input,
		'-map',
		'0:a',
		'-map',
		'0:v?',
		'-c:v',
		'copy',
		'-af',
		buildLoudnormFilter(stats),
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
 * Run the loudnorm analysis pass and parse its JSON block (printed to stderr).
 * Returns null if the file can't be analyzed or the JSON is missing/incomplete.
 */
export async function measureLoudness(filepath: string): Promise<LoudnessStats | null> {
	try {
		const { stderr } = await run(FFMPEG, buildMeasureArgs(filepath))
		const match = stderr.match(/\{[\s\S]*\}/)
		if (!match) return null
		const parsed = JSON.parse(match[0]) as Partial<LoudnessStats>
		if (
			parsed.input_i === undefined ||
			parsed.input_tp === undefined ||
			parsed.input_lra === undefined ||
			parsed.input_thresh === undefined ||
			parsed.target_offset === undefined
		) {
			return null
		}
		return {
			input_i: parsed.input_i,
			input_tp: parsed.input_tp,
			input_lra: parsed.input_lra,
			input_thresh: parsed.input_thresh,
			target_offset: parsed.target_offset,
		}
	} catch {
		return null
	}
}

/**
 * Normalize a file in place to the canonical format AND loudness. No-op
 * (`unchanged`) when the file is already at the target sample rate and within
 * the loudness tolerance, or when the rate is already canonical but loudness
 * can't be measured (we don't risk a blind re-encode for an unknown gain).
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

	// Measure loudness for the two-pass apply (and to decide if a re-encode is
	// even needed). May be null if analysis fails — handled below.
	const stats = await measureLoudness(filepath)
	const measuredI = stats ? Number.parseFloat(stats.input_i) : Number.NaN
	const loudnessKnown = Number.isFinite(measuredI)
	const sourceLoudnessLufs = loudnessKnown ? measuredI : null

	const rateOk = sourceSampleRate === TARGET_SAMPLE_RATE
	// Rate is fine but we couldn't measure loudness: leave it alone rather than
	// blindly re-encode an unknown gain (and lose a generation for nothing).
	if (rateOk && !loudnessKnown) {
		return { status: 'unchanged', sourceSampleRate, sourceLoudnessLufs }
	}
	if (!needsNormalization(sourceSampleRate, measuredI)) {
		return { status: 'unchanged', sourceSampleRate, sourceLoudnessLufs }
	}

	// Unique per call (randomUUID) so concurrent uploads of the same filename
	// can't collide on the temp path — `process.pid` is constant in this
	// single, long-lived server process and gives no per-upload uniqueness.
	const dir = path.dirname(filepath)
	const tmp = path.join(dir, `.normalizing-${path.basename(filepath)}.${randomUUID()}.tmp.mp3`)

	try {
		const { code, stderr } = await run(FFMPEG, buildNormalizeArgs(filepath, tmp, stats))
		if (code !== 0) {
			throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)
		}

		const outRate = await probeSampleRate(tmp)
		if (outRate !== TARGET_SAMPLE_RATE) {
			throw new Error(`output sample rate is ${outRate}, expected ${TARGET_SAMPLE_RATE}`)
		}

		fs.renameSync(tmp, filepath)
		return { status: 'normalized', sourceSampleRate, sourceLoudnessLufs }
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
