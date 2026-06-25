import { describe, expect, test } from 'bun:test'
import {
	buildNormalizeArgs,
	needsNormalization,
	TARGET_CHANNELS,
	TARGET_SAMPLE_RATE,
} from './audioNormalizer'

describe('needsNormalization', () => {
	test('48000 Hz needs normalization', () => {
		expect(needsNormalization(48000)).toBe(true)
	})

	test('44100 Hz (canonical) does not', () => {
		expect(needsNormalization(44100)).toBe(false)
	})

	test('other rates (22050, 32000, 96000) need normalization', () => {
		expect(needsNormalization(22050)).toBe(true)
		expect(needsNormalization(32000)).toBe(true)
		expect(needsNormalization(96000)).toBe(true)
	})

	test('canonical constants', () => {
		expect(TARGET_SAMPLE_RATE).toBe(44100)
		expect(TARGET_CHANNELS).toBe(2)
	})
})

describe('buildNormalizeArgs', () => {
	const args = buildNormalizeArgs('/songs/in put.mp3', '/songs/.tmp.mp3')

	test('uses input and output paths verbatim (no shell quoting)', () => {
		// spawn gets an arg array, so spaces in paths are preserved as-is.
		expect(args).toContain('/songs/in put.mp3')
		expect(args[args.length - 1]).toBe('/songs/.tmp.mp3')
		expect(args[0]).toBe('-i')
		expect(args[1]).toBe('/songs/in put.mp3')
	})

	// Walk adjacent flag/value pairs so we assert intent, not array index math.
	const pairs = new Map<string, string>()
	for (let i = 0; i < args.length - 1; i++) {
		const flag = args[i]
		const value = args[i + 1]
		if (flag !== undefined && value !== undefined) pairs.set(flag, value)
	}

	test('targets canonical sample rate and channels', () => {
		expect(pairs.get('-ar')).toBe(String(TARGET_SAMPLE_RATE))
		expect(pairs.get('-ac')).toBe(String(TARGET_CHANNELS))
	})

	test('encodes MPEG1 Layer III via libmp3lame at VBR V0', () => {
		expect(pairs.get('-c:a')).toBe('libmp3lame')
		expect(pairs.get('-q:a')).toBe('0')
	})

	test('preserves ID3 metadata', () => {
		expect(pairs.get('-map_metadata')).toBe('0')
		expect(pairs.get('-id3v2_version')).toBe('3')
	})

	test('keeps audio and passes through an optional embedded cover', () => {
		expect(args).toContain('0:a')
		expect(args).toContain('0:v?')
		expect(pairs.get('-c:v')).toBe('copy')
	})

	test('overwrites output without prompting', () => {
		expect(args).toContain('-y')
	})
})
