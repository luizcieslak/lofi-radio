import { describe, expect, test } from 'bun:test'
import { recordingFilename, slugify } from './recordingPaths'

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
	test('names a scene render by track slug, scene id and size', () => {
		expect(recordingFilename('Novel.mp3', 'a1b2c3')).toBe('novel-a1b2c3-1080x1920.mp4')
	})
})
