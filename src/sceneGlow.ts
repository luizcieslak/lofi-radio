/**
 * SCENE GLOW (campaign branch)
 *
 * The look of the cover glow in a scene's video: blur, blob sizes, colour
 * extraction… the controls of cieslak-dev's glow sandbox. The site reads them as
 * `?glow*=` URL params (`src/lib/glow-params.ts`, which this file mirrors), on
 * top of /radio's own look. A scene stores only what differs from that look, so
 * a scene with no `glow` renders exactly as /radio does.
 *
 * Pure, so the route and the recorder share one validator and one URL builder.
 */

export type GlowNumberKey =
	| 'blur'
	| 'sizeMultiplier'
	| 'majorBlobRadius'
	| 'gridSize'
	| 'binSize'
	| 'majorBlobCount'
	| 'majorBlobOpacity'
	| 'jitter'
	| 'horizontalStretch'
	| 'verticalStretch'
	| 'blackThreshold'
	| 'whiteThreshold'
	| 'majorBlobFeather'
	| 'edgeBleed'
	| 'sideBloomCount'
	| 'sideBloomOpacity'
	| 'sideBloomRadius'

export type GlowFlagKey = 'skipTransparent' | 'skipBlack' | 'skipWhite'

/**
 * Every numeric setting with the site's range and /radio's value (`default`,
 * RADIO_GLOW_PRESET on the site). `integer` ones are counts and grid sizes.
 */
export const GLOW_NUMBERS: ReadonlyArray<{
	key: GlowNumberKey
	label: string
	min: number
	max: number
	step: number
	default: number
	integer?: boolean
}> = [
	{ key: 'blur', label: 'Blur', min: 0, max: 120, step: 1, default: 56 },
	{ key: 'sizeMultiplier', label: 'Size multiplier', min: 1, max: 3, step: 0.05, default: 2.05 },
	{ key: 'majorBlobRadius', label: 'Major blob radius', min: 5, max: 60, step: 1, default: 30 },
	{ key: 'gridSize', label: 'Grid size', min: 2, max: 8, step: 1, default: 5, integer: true },
	{ key: 'binSize', label: 'Color bin size', min: 4, max: 128, step: 4, default: 64, integer: true },
	{ key: 'majorBlobCount', label: 'Major blob count', min: 1, max: 12, step: 1, default: 5, integer: true },
	{ key: 'majorBlobOpacity', label: 'Major blob opacity', min: 0, max: 1, step: 0.01, default: 0.8 },
	{ key: 'jitter', label: 'Jitter', min: 0, max: 50, step: 1, default: 22 },
	{ key: 'horizontalStretch', label: 'Horizontal stretch', min: 0.5, max: 2.5, step: 0.01, default: 1.5 },
	{ key: 'verticalStretch', label: 'Vertical stretch', min: 0.5, max: 2.5, step: 0.01, default: 1.18 },
	{ key: 'blackThreshold', label: 'Black threshold', min: 0, max: 100, step: 1, default: 20 },
	{ key: 'whiteThreshold', label: 'White threshold', min: 150, max: 255, step: 1, default: 235 },
	{ key: 'majorBlobFeather', label: 'Major blob feather', min: 20, max: 100, step: 1, default: 74 },
	{ key: 'edgeBleed', label: 'Edge bleed', min: 0, max: 50, step: 1, default: 30 },
	{ key: 'sideBloomCount', label: 'Side bloom count', min: 0, max: 6, step: 1, default: 2, integer: true },
	{ key: 'sideBloomOpacity', label: 'Side bloom opacity', min: 0, max: 1, step: 0.01, default: 0.34 },
	{ key: 'sideBloomRadius', label: 'Side bloom radius', min: 10, max: 80, step: 1, default: 48 },
]

export const GLOW_FLAGS: ReadonlyArray<{ key: GlowFlagKey; label: string; default: boolean }> = [
	{ key: 'skipTransparent', label: 'Skip transparent pixels', default: true },
	{ key: 'skipBlack', label: 'Skip near-black pixels', default: true },
	{ key: 'skipWhite', label: 'Skip near-white pixels', default: true },
]

export type SceneGlow = Partial<Record<GlowNumberKey, number> & Record<GlowFlagKey, boolean>>

/** `blur` → `glowBlur`, the site's URL param. */
export function glowParamName(key: GlowNumberKey | GlowFlagKey): string {
	return `glow${key[0]?.toUpperCase()}${key.slice(1)}`
}

export type GlowValidationResult = { ok: true; glow: SceneGlow } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a scene's glow settings. Like the pulse, out-of-range values and
 * unknown keys are rejected rather than clamped or kept: the site would clamp
 * (and round the integer ones), so the stored scene wouldn't be what renders.
 */
export function validateGlow(input: unknown): GlowValidationResult {
	if (!isRecord(input)) return { ok: false, error: 'must be an object' }

	const known = new Set<string>([...GLOW_NUMBERS.map(({ key }) => key), ...GLOW_FLAGS.map(({ key }) => key)])
	for (const key of Object.keys(input)) {
		if (!known.has(key)) return { ok: false, error: `has an unknown setting "${key}"` }
	}

	const glow: SceneGlow = {}
	for (const { key, min, max, integer } of GLOW_NUMBERS) {
		const value = input[key]
		if (value === undefined) continue
		if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
			return { ok: false, error: `${key} must be a number from ${min} to ${max}` }
		}
		if (integer && !Number.isInteger(value)) return { ok: false, error: `${key} must be a whole number` }
		glow[key] = value
	}
	for (const { key } of GLOW_FLAGS) {
		const value = input[key]
		if (value === undefined) continue
		if (typeof value !== 'boolean') return { ok: false, error: `${key} must be a boolean` }
		glow[key] = value
	}
	return { ok: true, glow }
}

/** The site's URL params for a scene's glow; settings equal to /radio's look are omitted. */
export function glowQuery(glow: SceneGlow | undefined): URLSearchParams {
	const params = new URLSearchParams()
	if (!glow) return params
	for (const { key, default: fallback } of GLOW_NUMBERS) {
		const value = glow[key]
		if (value !== undefined && value !== fallback) params.set(glowParamName(key), String(value))
	}
	for (const { key, default: fallback } of GLOW_FLAGS) {
		const value = glow[key]
		if (value !== undefined && value !== fallback) params.set(glowParamName(key), value ? '1' : '0')
	}
	return params
}
