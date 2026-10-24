/**
 * RENDER RUNNER (campaign branch)
 *
 * Runs scripts/recordClips.ts on behalf of the scene editor and keeps a snapshot
 * of its progress, which the editor polls (GET /admin/renders). The script is run
 * as-is, as a child process: it already isolates each capture in a process of its
 * own, for reasons documented there, and running it in the server would also put
 * real-time captures on the thread that paces the broadcast.
 *
 * Progress comes from the script's `@event` lines (src/renderEvents.ts), not from
 * its human log, which stays free to change wording.
 *
 * One run at a time: captures are real time and share the GPU, so two would only
 * slow each other into stalls.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { type PlannedRender, parseRenderEvent, type RenderEvent } from './renderEvents'

const PROJECT_ROOT = path.join(__dirname, '..')
const SCRIPT = path.join(PROJECT_ROOT, 'scripts/recordClips.ts')

/** Lines of plain recorder output kept for the editor's log view. */
const LOG_LIMIT = 500

/** How long a cancelled run gets to shut its browser down before SIGKILL. */
const CANCEL_GRACE_MS = 5_000

/** Ceiling on a `--dry-run`: it only fetches the scene list and prints the plan. */
const PLAN_TIMEOUT_MS = 30_000

/** What to render: the recorder's own `--clip` / `--track` / no-argument modes. */
export type RenderScope =
	| { kind: 'all'; includeRecorded: boolean }
	| { kind: 'track'; filename: string; includeRecorded: boolean }
	/** One scene, rendered even when it is marked recorded (as `--clip` does). */
	| { kind: 'clip'; clipId: string }

export type RenderJobStatus = 'queued' | 'rendering' | 'done' | 'failed'

export interface RenderJobState extends PlannedRender {
	status: RenderJobStatus
	/** The recorder's latest step for this scene, e.g. "capturing 58s (…)". */
	step?: string
	/** When `step` began (epoch ms), so the editor can estimate a capture's progress. */
	stepStartedAt?: number
	startedAt?: number
	finishedAt?: number
	error?: string
}

export interface RenderRun {
	id: number
	scope: RenderScope
	running: boolean
	cancelled: boolean
	startedAt: number
	finishedAt?: number
	exitCode?: number | null
	/** Scene ids in render order. Empty until the recorder has printed its plan. */
	order: string[]
	jobs: Record<string, RenderJobState>
	log: string[]
	/** Why the run failed as a whole (e.g. preflight), when no scene says so itself. */
	error?: string
}

export interface RenderEnvironment {
	radioUrl: string
	siteUrl?: string
}

function scopeArgs(scope: RenderScope): string[] {
	switch (scope.kind) {
		case 'clip':
			return ['--clip', scope.clipId]
		case 'track':
			return ['--track', scope.filename, ...(scope.includeRecorded ? ['--include-recorded'] : [])]
		case 'all':
			return scope.includeRecorded ? ['--include-recorded'] : []
	}
}

function spawnRecorder(args: string[], environment: RenderEnvironment): ChildProcess {
	return spawn(process.execPath, [SCRIPT, ...args], {
		cwd: PROJECT_ROOT,
		env: {
			...process.env,
			RECORD_EVENTS: '1',
			RADIO_URL: environment.radioUrl,
			...(environment.siteUrl ? { SITE_URL: environment.siteUrl } : {}),
		},
		// Its own process group, so cancelling reaches the per-scene children and
		// their ffmpeg encoders too, not just the batch parent.
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
}

/** Calls `onLine` per complete line; a chunk can end mid-line. */
function eachLine(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
	let pending = ''
	stream?.on('data', chunk => {
		const lines = (pending + String(chunk)).split('\n')
		pending = lines.pop() ?? ''
		for (const line of lines) onLine(line)
	})
	stream?.on('end', () => {
		if (pending) onLine(pending)
		pending = ''
	})
}

export class RenderRunner {
	private run: RenderRun | null = null
	private child: ChildProcess | null = null
	private nextId = 1

	snapshot(): RenderRun | null {
		return this.run
	}

	isRunning(): boolean {
		return this.run?.running === true
	}

	/**
	 * What a scope would render, without rendering it: the recorder's `--dry-run`
	 * plan. Leaves the current or last run untouched.
	 */
	plan(scope: RenderScope, environment: RenderEnvironment): Promise<PlannedRender[]> {
		return new Promise((resolve, reject) => {
			const child = spawnRecorder([...scopeArgs(scope), '--dry-run'], environment)
			let jobs: PlannedRender[] | null = null
			let stderr = ''
			const timer = setTimeout(() => {
				child.kill('SIGKILL')
				reject(new Error(`the recorder did not plan within ${PLAN_TIMEOUT_MS / 1000}s`))
			}, PLAN_TIMEOUT_MS)
			eachLine(child.stdout, line => {
				const event = parseRenderEvent(line)
				if (event?.type === 'plan') jobs = event.jobs
			})
			child.stderr?.on('data', chunk => {
				stderr += String(chunk)
			})
			child.on('error', error => {
				clearTimeout(timer)
				reject(error)
			})
			child.on('close', code => {
				clearTimeout(timer)
				if (jobs) resolve(jobs)
				else reject(new Error(stderr.trim() || `the recorder exited ${code} without a plan`))
			})
		})
	}

	/** Start a run. Throws when one is already in progress. */
	start(scope: RenderScope, environment: RenderEnvironment): RenderRun {
		if (this.isRunning()) throw new Error('a render is already running')

		const run: RenderRun = {
			id: this.nextId++,
			scope,
			running: true,
			cancelled: false,
			startedAt: Date.now(),
			order: [],
			jobs: {},
			log: [],
		}
		this.run = run

		const child = spawnRecorder(scopeArgs(scope), environment)
		this.child = child

		const log = (line: string) => {
			run.log.push(line)
			if (run.log.length > LOG_LIMIT) run.log.splice(0, run.log.length - LOG_LIMIT)
		}
		eachLine(child.stdout, line => {
			const event = parseRenderEvent(line)
			if (event) this.apply(run, event)
			else log(line)
		})
		eachLine(child.stderr, log)

		child.on('error', error => {
			run.error = `could not start the recorder: ${error.message}`
		})
		child.on('close', code => {
			if (this.child === child) this.child = null
			this.finish(run, code)
		})
		return run
	}

	/**
	 * Stop the run. SIGTERM to the whole group first: the recorder's Playwright
	 * closes its browser on it, which a SIGKILL would orphan. SIGKILL follows for
	 * anything still alive after the grace period.
	 */
	cancel(): boolean {
		const run = this.run
		const child = this.child
		if (!run?.running || !child?.pid) return false
		run.cancelled = true
		const group = -child.pid
		const signal = (name: NodeJS.Signals) => {
			try {
				process.kill(group, name)
			} catch {
				// ESRCH: the group is already gone.
			}
		}
		signal('SIGTERM')
		setTimeout(() => signal('SIGKILL'), CANCEL_GRACE_MS)
		return true
	}

	private apply(run: RenderRun, event: RenderEvent): void {
		if (event.type === 'plan') {
			run.order = event.jobs.map(job => job.clipId)
			run.jobs = Object.fromEntries(event.jobs.map(job => [job.clipId, { ...job, status: 'queued' }]))
			return
		}
		const job = run.jobs[event.clipId]
		if (!job) return
		const now = Date.now()
		switch (event.type) {
			case 'start':
				Object.assign(job, { status: 'rendering', startedAt: now })
				break
			case 'step':
				Object.assign(job, { step: event.message, stepStartedAt: now })
				break
			case 'done':
				Object.assign(job, { status: 'done', outputPath: event.outputPath, finishedAt: now })
				break
			case 'fail':
				// A cancel kills the encoder first, so the recorder reports that as the
				// failure ("the encoder closed mid-capture"); the cause is the cancel.
				Object.assign(job, {
					status: 'failed',
					error: run.cancelled ? 'cancelled' : event.error,
					finishedAt: now,
				})
				break
		}
	}

	private finish(run: RenderRun, code: number | null): void {
		run.running = false
		run.finishedAt = Date.now()
		run.exitCode = code

		// The recorder's last words, for a run that died without saying which scene.
		const lastLine = [...run.log]
			.reverse()
			.find(line => line.trim() !== '')
			?.trim()
		const unfinished = Object.values(run.jobs).filter(
			job => job.status === 'queued' || job.status === 'rendering',
		)
		for (const job of unfinished) {
			job.status = 'failed'
			job.finishedAt = run.finishedAt
			job.error = run.cancelled ? 'cancelled' : (lastLine ?? `the recorder exited ${code}`)
		}
		if (!run.cancelled && code !== 0 && !run.error && run.order.length === 0) {
			run.error = lastLine ?? `the recorder exited ${code}`
		}
	}
}

/**
 * The server's runner. Kept on globalThis because `bun --hot` re-evaluates this
 * module on every edit: a fresh instance would lose track of a render already in
 * progress, leaving it uncancellable and invisible to the editor.
 */
declare global {
	var __lofiRenderRunner: RenderRunner | undefined
}
globalThis.__lofiRenderRunner ??= new RenderRunner()
export const renderRunner: RenderRunner = globalThis.__lofiRenderRunner
