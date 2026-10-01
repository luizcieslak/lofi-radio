import { describe, expect, test } from 'bun:test'
import { validateClips } from './clipValidation'
import { PULSE_NUMBERS, pulseQuery, type ScenePulse, validatePulse } from './scenePulse'

describe('validatePulse — accepts', () => {
	test('just a strength', () => {
		expect(validatePulse({ amount: 0.5 })).toEqual({ ok: true, pulse: { amount: 0.5 } })
	})

	test('a mode and knobs at their range edges', () => {
		const input = {
			amount: 3,
			mode: 'boombap',
			pulseBass: 0,
			pulseTreble: 4,
			pulseSmooth: 0.25,
			pulseSnareStrict: 6,
		} satisfies ScenePulse
		expect(validatePulse(input)).toEqual({ ok: true, pulse: input })
	})

	test('strength 0 (pulse explicitly off for the scene)', () => {
		expect(validatePulse({ amount: 0 }).ok).toBe(true)
	})
})

describe('validatePulse — rejects', () => {
	const expectError = (input: unknown, fragment: string) => {
		const result = validatePulse(input)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toContain(fragment)
	}

	test('a non-object', () => {
		expectError(null, 'must be an object')
		expectError([1], 'must be an object')
	})

	test('a missing or out-of-range strength', () => {
		expectError({}, 'amount')
		expectError({ amount: -0.1 }, 'amount')
		expectError({ amount: 3.5 }, 'amount')
		expectError({ amount: '1' }, 'amount')
	})

	test('an unknown mode', () => {
		expectError({ amount: 1, mode: 'trap' }, 'mode must be one of')
	})

	test('a knob outside its range, rather than clamping it', () => {
		expectError({ amount: 1, pulseBass: 4.1 }, 'pulseBass')
		expectError({ amount: 1, pulseSmooth: 0.2 }, 'pulseSmooth')
		expectError({ amount: 1, pulseKickShape: 0.5 }, 'pulseKickShape')
	})

	test('an unknown setting, so a typo cannot persist as a no-op', () => {
		expectError({ amount: 1, pulseBas: 2 }, 'unknown setting "pulseBas"')
	})
})

describe('pulseQuery', () => {
	test('no pulse adds nothing, leaving the site on its own behaviour', () => {
		expect(pulseQuery(undefined).toString()).toBe('')
	})

	test('omits settings equal to the site default', () => {
		const defaults = Object.fromEntries(PULSE_NUMBERS.map(({ key, default: value }) => [key, value]))
		expect(pulseQuery({ amount: 1, ...defaults }).toString()).toBe('pulse=1')
	})

	test('reproduces the knobs that differ', () => {
		const query = pulseQuery({
			amount: 0.5,
			mode: 'boombap',
			pulseBass: 1.05,
			pulseKick: 0.65,
			pulseSmooth: 1.7,
		})
		expect(query.toString()).toBe('pulse=0.5&pulseMode=boombap&pulseBass=1.05&pulseKick=0.65&pulseSmooth=1.7')
	})

	test('strength 0 sends only pulse=0, which the site reads as "off"', () => {
		expect(pulseQuery({ amount: 0, mode: 'kick', pulseBass: 2 }).toString()).toBe('pulse=0')
	})
})

describe('validateClips with pulse', () => {
	test('keeps a valid pulse on the clip', () => {
		const result = validateClips([{ startMs: 0, endMs: 10, pulse: { amount: 1, mode: 'kick' } }], () => 'id')
		expect(result.ok && result.clips[0]?.pulse).toEqual({ amount: 1, mode: 'kick' })
	})

	test('rejects the whole payload on a bad pulse, naming the clip', () => {
		const result = validateClips([{ startMs: 0, endMs: 10, pulse: { amount: 9 } }], () => 'id')
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toContain('clips[0].pulse amount')
	})
})
