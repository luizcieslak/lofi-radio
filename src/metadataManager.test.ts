import { afterEach, describe, expect, test } from 'bun:test'
import { metadataManager } from './metadataManager'
import type { Clip } from './types'

/**
 * Covers the `blankEntry` path: clips (and duration backfills) must land even on
 * tracks that have no metadata entry at all — a file dropped straight into
 * songs/, or a restore without tracks-meta.json.
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
