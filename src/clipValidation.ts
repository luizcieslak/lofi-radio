/**
 * CLIP VALIDATION (campaign branch)
 *
 * Pure validation for clip-marker payloads, kept out of the route so it can be
 * unit-tested without HTTP. Express hands us `req.body` as `any`, so everything
 * here narrows from `unknown` with real runtime checks — no type assertions.
 */

import type { Clip } from './types'

/** Guard rails so a bad client can't bloat tracks-meta.json. */
export const MAX_CLIPS_PER_TRACK = 50
export const MAX_LABEL_LENGTH = 200
/**
 * Sanity ceiling on clip timestamps (3h). The route deliberately avoids looking
 * up the real track duration (that would need a frame walk on the request path —
 * see the seek route), but an absolute bound still keeps values like 9e15 from
 * persisting and exporting as a nonsense cut. Real tracks are minutes long.
 */
export const MAX_CLIP_MS = 3 * 60 * 60 * 1000

export type ClipValidationResult = { ok: true; clips: Clip[] } | { ok: false; error: string }

/**
 * Parse a hand-typed timestamp into milliseconds.
 *
 * Accepts what the UI actually shows and what it exports:
 *   "1:23"      -> 83000    (m:ss, matching the timecode readout)
 *   "1:23.5"    -> 83500    (fractional seconds)
 *   "1:02:03"   -> 3723000  (h:mm:ss, for long files)
 *   "83000"     -> 83000    (raw ms, matching the exported JSON)
 *   "45.5"      -> 45.5     (raw ms, fractional)
 *
 * A bare number is milliseconds, not seconds — that keeps it consistent with the
 * export format, which is the other thing a user would paste from.
 *
 * Returns null when unparseable, so callers can distinguish "bad input" from a
 * legitimate 0.
 */
export function parseTimestamp(input: string): number | null {
	const trimmed = input.trim()
	if (trimmed === '') return null

	// Colon form: [h:]m:ss[.fff]
	if (trimmed.includes(':')) {
		const parts = trimmed.split(':')
		if (parts.length > 3) return null

		let totalMs = 0
		for (const [index, part] of parts.entries()) {
			// Only the final segment may carry a fraction.
			const isLast = index === parts.length - 1
			const pattern = isLast ? /^\d+(\.\d+)?$/ : /^\d+$/
			if (!pattern.test(part)) return null

			const value = Number(part)
			if (!Number.isFinite(value)) return null
			// Minutes and seconds must be < 60 unless the segment is the leading one.
			if (index > 0 && value >= 60) return null

			totalMs = totalMs * 60 + value
		}
		return Math.round(totalMs * 1000)
	}

	// Bare number: milliseconds.
	if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
	const ms = Number(trimmed)
	return Number.isFinite(ms) ? ms : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Validate a clips payload and return normalized clips.
 *
 * Rejects the whole request on any invalid entry rather than dropping entries
 * silently — a partial save reported as success is worse than an error. Clips
 * missing an `id` get one assigned, so a client can submit a new clip without
 * inventing one.
 */
export function validateClips(
	input: unknown,
	makeId: () => string = () => crypto.randomUUID(),
): ClipValidationResult {
	if (!Array.isArray(input)) {
		return { ok: false, error: 'clips must be an array' }
	}

	if (input.length > MAX_CLIPS_PER_TRACK) {
		return { ok: false, error: `Too many clips (max ${MAX_CLIPS_PER_TRACK})` }
	}

	const clips: Clip[] = []
	const seenIds = new Set<string>()

	for (const [index, raw] of input.entries()) {
		if (!isRecord(raw)) {
			return { ok: false, error: `clips[${index}] must be an object` }
		}

		const { startMs, endMs, label, id } = raw

		if (!isFiniteNumber(startMs) || startMs < 0) {
			return { ok: false, error: `clips[${index}].startMs must be a finite number >= 0` }
		}

		if (!isFiniteNumber(endMs)) {
			return { ok: false, error: `clips[${index}].endMs must be a finite number` }
		}

		if (endMs <= startMs) {
			return { ok: false, error: `clips[${index}].endMs must be greater than startMs` }
		}

		if (endMs > MAX_CLIP_MS) {
			return { ok: false, error: `clips[${index}].endMs exceeds the maximum of ${MAX_CLIP_MS}ms` }
		}

		if (label !== undefined && typeof label !== 'string') {
			return { ok: false, error: `clips[${index}].label must be a string` }
		}

		if (typeof label === 'string' && label.length > MAX_LABEL_LENGTH) {
			return { ok: false, error: `clips[${index}].label exceeds ${MAX_LABEL_LENGTH} characters` }
		}

		if (id !== undefined && typeof id !== 'string') {
			return { ok: false, error: `clips[${index}].id must be a string` }
		}

		// Duplicate ids would make delete-by-id remove several rows at once, so the
		// UI could never address a clip individually.
		const clipId = typeof id === 'string' && id.length > 0 ? id : makeId()
		if (seenIds.has(clipId)) {
			return { ok: false, error: `clips[${index}].id is a duplicate` }
		}
		seenIds.add(clipId)

		// Round to whole ms: the playhead is a float (frame durations are 1152/44100
		// s), and sub-millisecond precision is meaningless for cutting video.
		const clip: Clip = { id: clipId, startMs: Math.round(startMs), endMs: Math.round(endMs) }
		if (typeof label === 'string' && label.length > 0) {
			clip.label = label
		}
		clips.push(clip)
	}

	return { ok: true, clips }
}
