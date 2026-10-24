/**
 * The recorder's machine-readable progress (campaign branch).
 *
 * scripts/recordClips.ts prints these, one per line, when RECORD_EVENTS=1 — which
 * is how the server's render runner (src/renderRunner.ts) follows a batch it
 * started from the scene editor. Run by hand, the script prints none of them, so
 * its terminal output is unchanged.
 *
 *   @event {"type":"plan","jobs":[…]}
 *   @event {"type":"start","clipId":"a1b2c3"}
 *   @event {"type":"step","clipId":"a1b2c3","message":"capturing 58s …"}
 *   @event {"type":"done","clipId":"a1b2c3","outputPath":"recordings/….mp4"}
 *   @event {"type":"fail","clipId":"a1b2c3","error":"…"}
 */

export const RENDER_EVENT_PREFIX = '@event '

export interface PlannedRender {
	clipId: string
	filename: string
	/** The track's title, as the page shows it. */
	title: string
	label?: string
	outputPath: string
	durationSeconds: number
}

export type RenderEvent =
	| { type: 'plan'; jobs: PlannedRender[] }
	| { type: 'start'; clipId: string }
	| { type: 'step'; clipId: string; message: string }
	| { type: 'done'; clipId: string; outputPath: string }
	| { type: 'fail'; clipId: string; error: string }

export function formatRenderEvent(event: RenderEvent): string {
	return `${RENDER_EVENT_PREFIX}${JSON.stringify(event)}`
}

const isString = (value: unknown): value is string => typeof value === 'string'

/** One field of a parsed JSON object, as `unknown` until checked. */
function field(value: object, key: string): unknown {
	return Reflect.get(value, key)
}

function parsePlanned(value: unknown): PlannedRender | null {
	if (typeof value !== 'object' || value === null) return null
	const clipId = field(value, 'clipId')
	const filename = field(value, 'filename')
	const title = field(value, 'title')
	const label = field(value, 'label')
	const outputPath = field(value, 'outputPath')
	const durationSeconds = field(value, 'durationSeconds')
	if (!isString(clipId) || !isString(filename) || !isString(title) || !isString(outputPath)) return null
	if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) return null
	return { clipId, filename, title, outputPath, durationSeconds, ...(isString(label) ? { label } : {}) }
}

/**
 * The event on one line of recorder output, or null for an ordinary log line.
 * Narrowed field by field: it is another process's output, not a value of ours.
 */
export function parseRenderEvent(line: string): RenderEvent | null {
	if (!line.startsWith(RENDER_EVENT_PREFIX)) return null
	let body: unknown
	try {
		body = JSON.parse(line.slice(RENDER_EVENT_PREFIX.length))
	} catch {
		return null
	}
	if (typeof body !== 'object' || body === null) return null
	const type = field(body, 'type')

	if (type === 'plan') {
		const raw = field(body, 'jobs')
		if (!Array.isArray(raw)) return null
		const jobs = raw.map(parsePlanned).filter(job => job !== null)
		return jobs.length === raw.length ? { type, jobs } : null
	}
	const clipId = field(body, 'clipId')
	if (!isString(clipId)) return null
	if (type === 'start') return { type, clipId }
	const message = field(body, 'message')
	if (type === 'step' && isString(message)) return { type, clipId, message }
	const outputPath = field(body, 'outputPath')
	if (type === 'done' && isString(outputPath)) return { type, clipId, outputPath }
	const error = field(body, 'error')
	if (type === 'fail' && isString(error)) return { type, clipId, error }
	return null
}
