import { describe, expect, test } from 'bun:test'
import {
	buildLoudnormFilter,
	buildMeasureArgs,
	buildNormalizeArgs,
	LOUDNESS_TOLERANCE_LU,
	type LoudnessStats,
	needsNormalization,
	TARGET_CHANNELS,
	TARGET_I,
	TARGET_SAMPLE_RATE,
} from './audioNormalizer'

describe('needsNormalization', () => {
	test('off-target sample rate needs normalization regardless of loudness', () => {
		expect(needsNormalization(48000, TARGET_I)).toBe(true)
		expect(needsNormalization(22050, TARGET_I)).toBe(true)
		expect(needsNormalization(96000, TARGET_I)).toBe(true)
	})

	test('canonical rate + on-target loudness does not', () => {
		expect(needsNormalization(44100, TARGET_I)).toBe(false)
	})

	test('canonical rate but loudness beyond tolerance needs normalization', () => {
		expect(needsNormalization(44100, TARGET_I - (LOUDNESS_TOLERANCE_LU + 0.5))).toBe(true)
		expect(needsNormalization(44100, TARGET_I + (LOUDNESS_TOLERANCE_LU + 0.5))).toBe(true)
	})

	test('canonical rate + loudness within tolerance does not', () => {
		expect(needsNormalization(44100, TARGET_I - (LOUDNESS_TOLERANCE_LU - 0.1))).toBe(false)
		expect(needsNormalization(44100, TARGET_I + (LOUDNESS_TOLERANCE_LU - 0.1))).toBe(false)
	})

	test('canonical constants', () => {
		expect(TARGET_SAMPLE_RATE).toBe(44100)
		expect(TARGET_CHANNELS).toBe(2)
		expect(TARGET_I).toBe(-14)
	})
})

describe('buildLoudnormFilter', () => {
	test('single-pass (no stats) omits measured values', () => {
		const f = buildLoudnormFilter(null)
		expect(f).toContain(`I=${TARGET_I}`)
		expect(f).not.toContain('measured_I')
		expect(f).not.toContain('linear=true')
	})

	test('two-pass (with stats) feeds back measured values + linear gain', () => {
		const stats: LoudnessStats = {
			input_i: '-10.30',
			input_tp: '-0.50',
			input_lra: '7.20',
			input_thresh: '-20.10',
			target_offset: '-0.10',
		}
		const f = buildLoudnormFilter(stats)
		expect(f).toContain('measured_I=-10.30')
		expect(f).toContain('measured_TP=-0.50')
		expect(f).toContain('measured_LRA=7.20')
		expect(f).toContain('measured_thresh=-20.10')
		expect(f).toContain('offset=-0.10')
		expect(f).toContain('linear=true')
	})
})

describe('buildMeasureArgs', () => {
	const args = buildMeasureArgs('/songs/in put.mp3')

	test('analyzes the input and writes nothing (null muxer, json output)', () => {
		expect(args).toContain('/songs/in put.mp3')
		expect(args).toContain('-f')
		expect(args).toContain('null')
		expect(args[args.length - 1]).toBe('-')
		expect(args.some(a => a.includes('print_format=json'))).toBe(true)
	})
})

describe('buildNormalizeArgs', () => {
	const args = buildNormalizeArgs('/songs/in put.mp3', '/songs/.tmp.mp3', null)

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

	test('applies a loudnorm audio filter', () => {
		expect(pairs.get('-af')).toContain('loudnorm=')
		expect(pairs.get('-af')).toContain(`I=${TARGET_I}`)
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

	test('two-pass variant carries measured values into the filter', () => {
		const stats: LoudnessStats = {
			input_i: '-9.00',
			input_tp: '-0.20',
			input_lra: '5.00',
			input_thresh: '-19.00',
			target_offset: '0.30',
		}
		const twoPass = buildNormalizeArgs('/songs/in.mp3', '/songs/.tmp.mp3', stats)
		const afIdx = twoPass.indexOf('-af')
		expect(afIdx).toBeGreaterThanOrEqual(0)
		expect(twoPass[afIdx + 1]).toContain('measured_I=-9.00')
	})
})
