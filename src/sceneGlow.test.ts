import { describe, expect, test } from 'bun:test'
import { validateClips } from './clipValidation'
import { GLOW_FLAGS, GLOW_NUMBERS, glowParamName, glowQuery, validateGlow } from './sceneGlow'

describe('validateGlow — accepts', () => {
	test('numbers at their range edges and flags', () => {
		const input = { blur: 0, sizeMultiplier: 3, gridSize: 8, skipBlack: false }
		expect(validateGlow(input)).toEqual({ ok: true, glow: input })
	})

	test('an empty object (the /radio look)', () => {
		expect(validateGlow({})).toEqual({ ok: true, glow: {} })
	})
})

describe('validateGlow — rejects', () => {
	const expectError = (input: unknown, fragment: string) => {
		const result = validateGlow(input)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toContain(fragment)
	}

	test('a non-object', () => {
		expectError(null, 'must be an object')
		expectError([], 'must be an object')
	})

	test('a number outside its range, rather than clamping it', () => {
		expectError({ blur: 121 }, 'blur')
		expectError({ majorBlobOpacity: -0.1 }, 'majorBlobOpacity')
		expectError({ jitter: '10' }, 'jitter')
	})

	test('a fraction where the site needs a whole number', () => {
		expectError({ gridSize: 4.5 }, 'gridSize must be a whole number')
	})

	test('a non-boolean flag', () => {
		expectError({ skipWhite: 1 }, 'skipWhite must be a boolean')
	})

	test('an unknown setting, fadeMs included', () => {
		expectError({ blurr: 4 }, 'unknown setting "blurr"')
		expectError({ fadeMs: 100 }, 'unknown setting "fadeMs"')
	})
})

describe('glowQuery', () => {
	test('no glow adds nothing', () => {
		expect(glowQuery(undefined).toString()).toBe('')
	})

	test('omits settings equal to /radio’s look', () => {
		const preset = Object.fromEntries([
			...GLOW_NUMBERS.map(({ key, default: value }) => [key, value]),
			...GLOW_FLAGS.map(({ key, default: value }) => [key, value]),
		])
		expect(glowQuery(preset).toString()).toBe('')
	})

	test('writes the prefixed params that differ, flags as 1/0', () => {
		expect(glowQuery({ blur: 80, verticalStretch: 1.4, skipBlack: false }).toString()).toBe(
			'glowBlur=80&glowVerticalStretch=1.4&glowSkipBlack=0',
		)
	})

	test('every default sits in its range and on a whole number where required', () => {
		for (const { key, min, max, default: value, integer } of GLOW_NUMBERS) {
			expect(value >= min && value <= max).toBe(true)
			if (integer) expect(Number.isInteger(value)).toBe(true)
			expect(glowParamName(key).startsWith('glow')).toBe(true)
		}
	})
})

describe('validateClips with glow', () => {
	test('keeps a valid glow on the clip', () => {
		const result = validateClips([{ startMs: 0, endMs: 10, glow: { blur: 70 } }], () => 'id')
		expect(result.ok && result.clips[0]?.glow).toEqual({ blur: 70 })
	})

	test('drops an empty glow', () => {
		const result = validateClips([{ startMs: 0, endMs: 10, glow: {} }], () => 'id')
		expect(result.ok && 'glow' in (result.clips[0] ?? {})).toBe(false)
	})

	test('rejects the whole payload on a bad glow, naming the clip', () => {
		const result = validateClips([{ startMs: 0, endMs: 10, glow: { blur: -1 } }], () => 'id')
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toContain('clips[0].glow blur')
	})
})
