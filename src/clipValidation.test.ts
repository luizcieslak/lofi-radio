import { describe, expect, test } from 'bun:test'
import {
	MAX_CLIP_MS,
	MAX_CLIPS_PER_TRACK,
	MAX_LABEL_LENGTH,
	parseTimestamp,
	validateClips,
} from './clipValidation'

describe('parseTimestamp', () => {
	test('m:ss as shown in the timecode readout', () => {
		expect(parseTimestamp('1:23')).toBe(83000)
		expect(parseTimestamp('0:45')).toBe(45000)
		expect(parseTimestamp('0:00')).toBe(0)
		expect(parseTimestamp('10:00')).toBe(600000)
	})

	test('fractional seconds', () => {
		expect(parseTimestamp('1:23.5')).toBe(83500)
		expect(parseTimestamp('0:00.25')).toBe(250)
	})

	test('h:mm:ss for long files', () => {
		expect(parseTimestamp('1:02:03')).toBe(3723000)
		expect(parseTimestamp('0:01:00')).toBe(60000)
	})

	test('a bare number is milliseconds, matching the export format', () => {
		expect(parseTimestamp('83000')).toBe(83000)
		expect(parseTimestamp('0')).toBe(0)
		expect(parseTimestamp('45.5')).toBe(45.5)
	})

	test('surrounding whitespace', () => {
		expect(parseTimestamp('  1:23  ')).toBe(83000)
		expect(parseTimestamp(' 83000 ')).toBe(83000)
	})

	test('rejects unparseable input rather than guessing', () => {
		for (const bad of ['', '   ', 'abc', '1:', ':30', '1:2:3:4', '1:60', '1:99', '-5', '-1:30', '1.2.3', '1:ab', '2:-3']) {
			expect(parseTimestamp(bad)).toBeNull()
		}
	})

	test('allows a leading segment >= 60 (90 minutes is not 1:30:00 typo bait)', () => {
		// "90:00" is 90 minutes; only non-leading segments are capped at 59.
		expect(parseTimestamp('90:00')).toBe(5400000)
	})
})

// Deterministic id generator so assertions don't depend on randomUUID.
function sequentialIds() {
	let n = 0
	return () => `id-${++n}`
}

describe('validateClips — accepts', () => {
	test('an empty array (clearing all clips)', () => {
		const result = validateClips([], sequentialIds())
		expect(result).toEqual({ ok: true, clips: [] })
	})

	test('a valid clip, assigning an id when missing', () => {
		const result = validateClips([{ startMs: 1000, endMs: 61000 }], sequentialIds())
		expect(result).toEqual({ ok: true, clips: [{ id: 'id-1', startMs: 1000, endMs: 61000 }] })
	})

	test('a caller-supplied id verbatim', () => {
		const result = validateClips([{ id: 'keep-me', startMs: 0, endMs: 500 }], sequentialIds())
		expect(result.ok && result.clips[0]?.id).toBe('keep-me')
	})

	test('an optional label, and omits an empty one', () => {
		const withLabel = validateClips([{ startMs: 0, endMs: 10, label: 'chorus' }], sequentialIds())
		expect(withLabel.ok && withLabel.clips[0]?.label).toBe('chorus')

		const emptyLabel = validateClips([{ startMs: 0, endMs: 10, label: '' }], sequentialIds())
		expect(emptyLabel.ok && 'label' in (emptyLabel.clips[0] ?? {})).toBe(false)
	})

	test('startMs of exactly 0', () => {
		expect(validateClips([{ startMs: 0, endMs: 1 }], sequentialIds()).ok).toBe(true)
	})

	test('rounds fractional ms — the playhead is a float, video cuts are not', () => {
		const result = validateClips([{ startMs: 78551.46938775518, endMs: 80082.9 }], sequentialIds())
		expect(result.ok && result.clips[0]).toEqual({ id: 'id-1', startMs: 78551, endMs: 80083 })
	})

	test('a full-capacity array', () => {
		const clips = Array.from({ length: MAX_CLIPS_PER_TRACK }, (_, i) => ({ startMs: i, endMs: i + 1 }))
		expect(validateClips(clips, sequentialIds()).ok).toBe(true)
	})
})

describe('validateClips — rejects', () => {
	const expectError = (input: unknown, fragment: string) => {
		const result = validateClips(input, sequentialIds())
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toContain(fragment)
	}

	test('non-array input', () => {
		expectError({ startMs: 0, endMs: 1 }, 'must be an array')
		expectError(null, 'must be an array')
		expectError('clips', 'must be an array')
	})

	test('more clips than the cap', () => {
		const tooMany = Array.from({ length: MAX_CLIPS_PER_TRACK + 1 }, (_, i) => ({ startMs: i, endMs: i + 1 }))
		expectError(tooMany, 'Too many clips')
	})

	test('a non-object entry', () => {
		expectError(['nope'], 'must be an object')
		expectError([null], 'must be an object')
		expectError([[1, 2]], 'must be an object')
	})

	test('a negative or non-finite startMs', () => {
		expectError([{ startMs: -1, endMs: 10 }], 'startMs')
		expectError([{ startMs: Number.NaN, endMs: 10 }], 'startMs')
		expectError([{ startMs: Number.POSITIVE_INFINITY, endMs: 10 }], 'startMs')
		expectError([{ startMs: '0', endMs: 10 }], 'startMs')
		expectError([{ endMs: 10 }], 'startMs')
	})

	test('a non-finite endMs', () => {
		expectError([{ startMs: 0, endMs: Number.NaN }], 'endMs')
		expectError([{ startMs: 0 }], 'endMs')
	})

	test('endMs at or before startMs (zero-length or inverted)', () => {
		expectError([{ startMs: 500, endMs: 500 }], 'greater than startMs')
		expectError([{ startMs: 900, endMs: 100 }], 'greater than startMs')
	})

	test('a non-string label, or one past the cap', () => {
		expectError([{ startMs: 0, endMs: 10, label: 42 }], 'label must be a string')
		expectError([{ startMs: 0, endMs: 10, label: 'x'.repeat(MAX_LABEL_LENGTH + 1) }], 'exceeds')
	})

	test('a non-string id', () => {
		expectError([{ id: 7, startMs: 0, endMs: 10 }], 'id must be a string')
	})

	test('absurd timestamps beyond the sanity ceiling', () => {
		// Without a ceiling these persist and export as a nonsense cut.
		expectError([{ startMs: 0, endMs: 9e15 }], 'exceeds the maximum')
		expectError([{ startMs: MAX_CLIP_MS, endMs: MAX_CLIP_MS + 1 }], 'exceeds the maximum')
	})

	test('duplicate ids', () => {
		expectError(
			[
				{ id: 'same', startMs: 0, endMs: 10 },
				{ id: 'same', startMs: 20, endMs: 30 },
			],
			'duplicate',
		)
	})

	test('the WHOLE payload when only one entry is bad', () => {
		const result = validateClips(
			[
				{ startMs: 0, endMs: 10 },
				{ startMs: 50, endMs: 20 },
			],
			sequentialIds(),
		)
		// Partial saves reported as success are worse than an error.
		expect(result.ok).toBe(false)
	})
})
