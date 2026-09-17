import { afterEach, describe, expect, test } from 'bun:test'
import { metadataManager } from './metadataManager'
import { type Clip, isTrackTheme } from './types'

/**
 * Covers the authoring writers that bypass `update()` — clips and theme — plus
 * the `blankEntry` path they share: both must land even on tracks with no
 * metadata entry at all (a file dropped straight into songs/, or a restore
 * without tracks-meta.json).
 *
 * Uses filenames that cannot collide with the real library, and clears them
 * afterwards so the developer's tracks-meta.json is left as it was found.
 */
const TEST_PREFIX = '__clip-test__'
const touched: string[] = []

function testFilename(name: string): string {
	const filename = `${TEST_PREFIX}${name}.mp3`
	touched.push(filename)
	return filename
}

afterEach(() => {
	for (const filename of touched.splice(0)) {
		metadataManager.delete(filename)
	}
})

const clip = (over: Partial<Clip> = {}): Clip => ({ id: 'c1', startMs: 1000, endMs: 2000, ...over })

describe('metadataManager clips', () => {
	test('getClips returns [] for an unknown track', () => {
		expect(metadataManager.getClips(testFilename('unknown'))).toEqual([])
	})

	test('setClips creates an entry for a track with no metadata', () => {
		const filename = testFilename('no-entry')
		expect(metadataManager.get(filename)).toBeUndefined()

		metadataManager.setClips(filename, [clip()])

		expect(metadataManager.getClips(filename)).toEqual([clip()])
		// The synthesized entry must be usable, not a bare {clips}: a non-empty
		// title derived from the filename (sans extension) and a fallback artist.
		const meta = metadataManager.get(filename)
		expect(meta?.title).toBeTruthy()
		expect(meta?.title).not.toContain('.mp3')
		expect(meta?.artist).toBe('Unknown Artist')
		expect(meta?.manuallyEdited).toBe(false)
	})

	test('setClips does NOT mark a track manuallyEdited', () => {
		const filename = testFilename('not-manual')
		metadataManager.setClips(filename, [clip()])
		// manuallyEdited tracks title/artist edits; clip authoring is not that.
		expect(metadataManager.get(filename)?.manuallyEdited).toBe(false)
	})

	test('setClips replaces wholesale rather than merging', () => {
		const filename = testFilename('replace')
		metadataManager.setClips(filename, [clip({ id: 'a' }), clip({ id: 'b' })])
		metadataManager.setClips(filename, [clip({ id: 'c' })])

		expect(metadataManager.getClips(filename).map(c => c.id)).toEqual(['c'])
	})

	test('setClips with [] clears the track and drops the key', () => {
		const filename = testFilename('clear')
		metadataManager.setClips(filename, [clip()])
		metadataManager.setClips(filename, [])

		expect(metadataManager.getClips(filename)).toEqual([])
		expect(metadataManager.getAllClips()[filename]).toBeUndefined()
		// Storing `clips: []` would accumulate empty arrays across the library.
		expect('clips' in (metadataManager.get(filename) ?? {})).toBe(false)
	})

	test('setClips preserves existing metadata fields', () => {
		const filename = testFilename('preserve')
		metadataManager.update(filename, { title: 'Real Title', artist: 'Real Artist' })
		metadataManager.setClips(filename, [clip()])

		const meta = metadataManager.get(filename)
		expect(meta?.title).toBe('Real Title')
		expect(meta?.artist).toBe('Real Artist')
		expect(meta?.clips).toEqual([clip()])
	})

	test('getAllClips only includes tracks that actually have clips', () => {
		const withClips = testFilename('with')
		const withoutClips = testFilename('without')

		metadataManager.setClips(withClips, [clip()])
		metadataManager.update(withoutClips, { title: 'No Clips Here' })

		const all = metadataManager.getAllClips()
		expect(all[withClips]).toEqual([clip()])
		expect(withoutClips in all).toBe(false)
	})

	test('deleting a track drops its clips', () => {
		const filename = testFilename('deleted')
		metadataManager.setClips(filename, [clip()])
		metadataManager.delete(filename)

		expect(metadataManager.getClips(filename)).toEqual([])
		expect(metadataManager.getAllClips()[filename]).toBeUndefined()
	})
})

describe('metadataManager theme', () => {
	test('setTheme creates an entry for a track with no metadata', () => {
		const filename = testFilename('theme-no-entry')
		expect(metadataManager.get(filename)).toBeUndefined()

		metadataManager.setTheme(filename, 'dark')

		expect(metadataManager.get(filename)?.theme).toBe('dark')
		expect(metadataManager.get(filename)?.title).toBeTruthy()
	})

	test('setTheme overwrites an existing theme', () => {
		const filename = testFilename('theme-overwrite')
		metadataManager.setTheme(filename, 'dark')
		metadataManager.setTheme(filename, 'light')

		expect(metadataManager.get(filename)?.theme).toBe('light')
	})

	test('setTheme(null) removes the key rather than storing undefined', () => {
		const filename = testFilename('theme-clear')
		metadataManager.setTheme(filename, 'dark')
		metadataManager.setTheme(filename, null)

		const meta = metadataManager.get(filename)
		// Absent, not present-but-undefined: otherwise memory and the saved JSON
		// disagree about whether a theme is set (JSON.stringify drops undefined).
		expect('theme' in (meta ?? {})).toBe(false)
		expect(meta?.theme).toBeUndefined()
	})

	test('setTheme preserves existing metadata and clips', () => {
		const filename = testFilename('theme-preserve')
		metadataManager.update(filename, { title: 'Real Title', artist: 'Real Artist' })
		metadataManager.setClips(filename, [clip()])
		metadataManager.setTheme(filename, 'dark')

		const meta = metadataManager.get(filename)
		expect(meta?.title).toBe('Real Title')
		expect(meta?.artist).toBe('Real Artist')
		expect(meta?.clips).toEqual([clip()])
		expect(meta?.theme).toBe('dark')
	})

	test('clearing a theme leaves other fields intact', () => {
		const filename = testFilename('theme-clear-preserve')
		metadataManager.update(filename, { title: 'Keep Me' })
		metadataManager.setTheme(filename, 'light')
		metadataManager.setTheme(filename, null)

		expect(metadataManager.get(filename)?.title).toBe('Keep Me')
	})

	test('setTheme marks the track manuallyEdited', () => {
		const filename = testFilename('theme-manual')
		metadataManager.setTheme(filename, 'dark')
		// Unlike clips, a theme is a presentation choice — the same class of edit
		// as title or cover art.
		expect(metadataManager.get(filename)?.manuallyEdited).toBe(true)
	})

	test('deleting a track drops its theme', () => {
		const filename = testFilename('theme-deleted')
		metadataManager.setTheme(filename, 'dark')
		metadataManager.delete(filename)

		expect(metadataManager.get(filename)).toBeUndefined()
	})
})

describe('isTrackTheme', () => {
	test('accepts the two valid themes', () => {
		expect(isTrackTheme('light')).toBe(true)
		expect(isTrackTheme('dark')).toBe(true)
	})

	test('rejects anything else, so a typo cannot reach the player', () => {
		for (const bad of ['', 'Light', 'DARK', 'auto', 'system', 'blue', null, undefined, 0, 1, {}, ['dark']]) {
			expect(isTrackTheme(bad)).toBe(false)
		}
	})
})
