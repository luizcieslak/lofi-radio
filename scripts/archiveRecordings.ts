/**
 * RECORDINGS CLEANUP (campaign branch)
 *
 * Clears `recordings/` for a fresh batch without deleting anything: every render
 * at the top level moves into `recordings/backup/<YYYY-MM-DDTHH-MM-SS>/`, stamped
 * with the run's local time, so every run gets a folder of its own. The time uses
 * `-` rather than `:`, which some filesystems and tools reject in names.
 *
 * Left in place:
 *   - `backup/` itself
 *   - dot entries, e.g. the `.work-<scene>` dirs recordClips.ts uses mid-render
 *
 * Two runs in the same second would share a stamp; the second gets a `-2`
 * suffix on its folder rather than mixing into the first.
 *
 * Usage:
 *   bun run scripts/archiveRecordings.ts             # move everything
 *   bun run scripts/archiveRecordings.ts --dry-run   # list what would move
 *
 * The scene editor runs the same thing through `archiveRecordings()` (POST
 * /admin/recordings/archive), which is why the work lives in an export.
 */

import { access, mkdir, readdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { OUTPUT_DIR } from '../src/recordingPaths'

const BACKUP = 'backup'

function timestamp(now: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0')
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
	return `${date}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
}

async function exists(file: string): Promise<boolean> {
	try {
		await access(file)
		return true
	} catch {
		return false
	}
}

/** A backup folder path no earlier run has used: `<stamp>`, else `<stamp>-2`… */
async function freeFolder(backupDir: string, stamp: string): Promise<string> {
	let candidate = path.join(backupDir, stamp)
	for (let n = 2; await exists(candidate); n++) {
		candidate = path.join(backupDir, `${stamp}-${n}`)
	}
	return candidate
}

export interface ArchiveOptions {
	dryRun?: boolean
	/** The recordings folder. Defaults to OUTPUT_DIR, relative to the cwd. */
	outputDir?: string
	/** The stamp's clock; injectable so tests can force a collision. */
	now?: Date
}

export interface ArchiveResult {
	/** Entry names moved (or, on a dry run, that would be), sorted. */
	moved: string[]
	/** The backup folder they went to; null when there was nothing to move. */
	target: string | null
}

export async function archiveRecordings({
	dryRun = false,
	outputDir = OUTPUT_DIR,
	now = new Date(),
}: ArchiveOptions = {}): Promise<ArchiveResult> {
	if (!(await exists(outputDir))) return { moved: [], target: null }

	const entries = (await readdir(outputDir)).filter(name => name !== BACKUP && !name.startsWith('.')).sort()
	if (entries.length === 0) return { moved: [], target: null }

	const target = await freeFolder(path.join(outputDir, BACKUP), timestamp(now))
	if (!dryRun) {
		await mkdir(target, { recursive: true })
		for (const name of entries) await rename(path.join(outputDir, name), path.join(target, name))
	}
	return { moved: entries, target }
}

async function main(): Promise<void> {
	const dryRun = process.argv.includes('--dry-run')

	if (!(await exists(OUTPUT_DIR))) {
		console.log(`No ${OUTPUT_DIR}/ directory; nothing to do.`)
		return
	}

	const { moved, target } = await archiveRecordings({ dryRun })
	if (!target) {
		console.log(`${OUTPUT_DIR}/ is already clean.`)
		return
	}

	for (const name of moved) {
		console.log(`${dryRun ? '[dry-run] ' : ''}${name} -> ${path.join(target, name)}`)
	}
	console.log(`${dryRun ? 'Would move' : 'Moved'} ${moved.length} item(s) to ${target}/`)
}

if (import.meta.main) await main()
