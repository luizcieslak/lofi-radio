import { describe, expect, test } from 'bun:test'
import { parseRecordingFilename, recordingFilename, slugify } from './recordingPaths'
import type { TrackTheme } from './types'

describe('slugify', () => {
	test('strips the extension and dashes everything else', () => {
		expect(slugify("Don't Stop (Remix).mp3")).toBe('don-t-stop-remix')
	})

	test('keeps the base letter of accented characters', () => {
		expect(slugify('Café Noir.mp3')).toBe('cafe-noir')
	})

	test('folds full-width unicode to ASCII', () => {
		expect(slugify('ＥＬＡ　ＭＯＲＡ.mp3')).toBe('ela-mora')
	})

	test('falls back when nothing survives', () => {
		expect(slugify('日本.mp3')).toBe('track')
	})
})

describe('recordingFilename', () => {
	test('names a scene render by track slug, scene id, theme and size', () => {
		expect(recordingFilename('Novel.mp3', 'a1b2c3', 'dark')).toBe('novel-a1b2c3-dark-1080x1920.mp4')
	})

	test('says `default` when neither scene nor track sets a theme', () => {
		expect(recordingFilename('Novel.mp3', 'a1b2c3')).toBe('novel-a1b2c3-default-1080x1920.mp4')
	})
})

describe('parseRecordingFilename', () => {
	test('reads the theme back out of a render of this scene', () => {
		const themes: TrackTheme[] = ['light', 'dark']
		for (const theme of themes) {
			expect(parseRecordingFilename(recordingFilename('Novel.mp3', 'a1', theme), 'Novel.mp3', 'a1')).toEqual({
				theme,
			})
		}
		expect(parseRecordingFilename(recordingFilename('Novel.mp3', 'a1'), 'Novel.mp3', 'a1')).toEqual({
			theme: 'default',
		})
	})

	test('still matches a render from before the theme was in the name', () => {
		expect(parseRecordingFilename('novel-a1-1080x1920.mp4', 'Novel.mp3', 'a1')).toEqual({ theme: null })
	})

	test("rejects another scene's render or an unknown theme", () => {
		expect(parseRecordingFilename('novel-a12-dark-1080x1920.mp4', 'Novel.mp3', 'a1')).toBeNull()
		expect(parseRecordingFilename('other-a1-dark-1080x1920.mp4', 'Novel.mp3', 'a1')).toBeNull()
		expect(parseRecordingFilename('novel-a1-sepia-1080x1920.mp4', 'Novel.mp3', 'a1')).toBeNull()
	})
})
