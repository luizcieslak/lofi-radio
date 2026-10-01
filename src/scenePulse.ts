/**
 * SCENE PULSE (campaign branch)
 *
 * How the cover glow reacts to the music in a scene's video. The glow itself
 * lives in cieslak-dev (`src/lib/ambient-glow`, `src/lib/audio-pulse.ts`), which
 * reads these as URL params (`src/lib/pulse-params.ts`); this file mirrors that
 * contract so scenes can store, validate and reproduce it. Ranges and defaults
 * match the site's — it clamps out-of-range values, but a stored scene should
 * never depend on that.
 *
 * Pure, so the route and the recorder share one validator and one URL builder.
 */

export const PULSE_MODES = ['bands', 'kick', 'transients', 'colour', 'breathe', 'orbit', 'boombap'] as const
export type PulseMode = (typeof PULSE_MODES)[number]

export function isPulseMode(value: unknown): value is PulseMode {
	return typeof value === 'string' && PULSE_MODES.some(mode => mode === value)
}

/** Numeric settings, keyed by their URL param on the site. */
export type PulseNumberKey =
	| 'pulseBass'
	| 'pulseTreble'
	| 'pulseKick'
	| 'pulseSnare'
	| 'pulseShimmer'
	| 'pulseSmooth'
	| 'pulseKickShape'
	| 'pulseSnareStrict'

/**
 * Every numeric setting with its range and the site's default. A value equal to
 * the default is omitted from the URL, so the site's own default applies.
 */
export const PULSE_NUMBERS: ReadonlyArray<{
	key: PulseNumberKey
	label: string
	min: number
	max: number
	default: number
}> = [
	{ key: 'pulseBass', label: 'Bass', min: 0, max: 4, default: 1 },
	{ key: 'pulseTreble', label: 'Treble', min: 0, max: 4, default: 1 },
	{ key: 'pulseKick', label: 'Kick', min: 0, max: 4, default: 1 },
	{ key: 'pulseSnare', label: 'Snare', min: 0, max: 4, default: 1 },
	{ key: 'pulseShimmer', label: 'Shimmer', min: 0, max: 4, default: 1 },
	{ key: 'pulseSmooth', label: 'Smooth', min: 0.25, max: 4, default: 1 },
	{ key: 'pulseKickShape', label: 'Kick shape', min: 1, max: 6, default: 2 },
	{ key: 'pulseSnareStrict', label: 'Snare strict', min: 1, max: 6, default: 3.5 },
]

/** `?pulse=` strength on the site: 0 is off, 1 the default, 3 the ceiling. */
export const PULSE_AMOUNT_MAX = 3

export type ScenePulse = {
	/** Strength (`?pulse=`). 0 turns the pulse off for this scene. */
	amount: number
	/** Behaviour (`?pulseMode=`); absent = the site's default ('bands'). */
	mode?: PulseMode
} & Partial<Record<PulseNumberKey, number>>

/**
 * The pulse a scene gets when it has none of its own — tuned for this library's
 * lofi / boom-bap material. A scene's own `pulse` (including `amount: 0`, i.e.
 * explicitly off) always wins; this only fills the gap, so retuning it here
 * restyles every scene that never chose otherwise. Served to the editor with the
 * scene list, so the editor, its preview and the recorder can't disagree.
 */
export const DEFAULT_SCENE_PULSE: ScenePulse = {
	amount: 0.95,
	mode: 'boombap',
	pulseBass: 1.05,
	pulseTreble: 0.3,
	pulseKick: 0.65,
	pulseSmooth: 1.7,
}

/** A scene's effective pulse: its own, else the default. */
export function resolveScenePulse(pulse: ScenePulse | undefined): ScenePulse {
	return pulse ?? DEFAULT_SCENE_PULSE
}

export type PulseValidationResult = { ok: true; pulse: ScenePulse } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Validate a scene's pulse settings. Out-of-range values are rejected rather
 * than clamped, like the rest of clip validation: a stored value the site would
 * silently change is a scene that won't render the way it previews. Unknown keys
 * are rejected too, so a typo can't persist as a setting that does nothing.
 */
export function validatePulse(input: unknown): PulseValidationResult {
	if (!isRecord(input)) return { ok: false, error: 'must be an object' }

	const known = new Set<string>(['amount', 'mode', ...PULSE_NUMBERS.map(({ key }) => key)])
	for (const key of Object.keys(input)) {
		if (!known.has(key)) return { ok: false, error: `has an unknown setting "${key}"` }
	}

	const { amount, mode } = input
	if (!isFiniteNumber(amount) || amount < 0 || amount > PULSE_AMOUNT_MAX) {
		return { ok: false, error: `amount must be a number from 0 to ${PULSE_AMOUNT_MAX}` }
	}

	const pulse: ScenePulse = { amount }

	if (mode !== undefined) {
		if (!isPulseMode(mode)) return { ok: false, error: `mode must be one of ${PULSE_MODES.join(', ')}` }
		pulse.mode = mode
	}

	for (const { key, min, max } of PULSE_NUMBERS) {
		const value = input[key]
		if (value === undefined) continue
		if (!isFiniteNumber(value) || value < min || value > max) {
			return { ok: false, error: `${key} must be a number from ${min} to ${max}` }
		}
		pulse[key] = value
	}

	return { ok: true, pulse }
}

/**
 * The site's URL params for a scene's pulse, defaults omitted. With no pulse the
 * result is empty and the site keeps its own behaviour (no pulse unless tapped).
 */
export function pulseQuery(pulse: ScenePulse | undefined): URLSearchParams {
	const params = new URLSearchParams()
	if (!pulse) return params

	params.set('pulse', String(pulse.amount))
	if (pulse.amount === 0) return params

	if (pulse.mode) params.set('pulseMode', pulse.mode)
	for (const { key, default: fallback } of PULSE_NUMBERS) {
		const value = pulse[key]
		if (value !== undefined && value !== fallback) params.set(key, String(value))
	}
	return params
}
