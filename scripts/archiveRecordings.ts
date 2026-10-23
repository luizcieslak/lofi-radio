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
 */

import { access, mkdir, readdir, rename } from 'node:fs/promises'
import path from 'node:path'

const OUTPUT_DIR = 'recordings'
const BACKUP_DIR = path.join(OUTPUT_DIR, 'backup')

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
async function freeFolder(stamp: string): Promise<string> {
	let candidate = path.join(BACKUP_DIR, stamp)
	for (let n = 2; await exists(candidate); n++) {
		candidate = path.join(BACKUP_DIR, `${stamp}-${n}`)
	}
	return candidate
}

async function main(): Promise<void> {
	const dryRun = process.argv.includes('--dry-run')

	if (!(await exists(OUTPUT_DIR))) {
		console.log(`No ${OUTPUT_DIR}/ directory; nothing to do.`)
		return
	}

	const entries = (await readdir(OUTPUT_DIR)).filter(name => name !== 'backup' && !name.startsWith('.'))
	if (entries.length === 0) {
		console.log(`${OUTPUT_DIR}/ is already clean.`)
		return
	}

	const target = await freeFolder(timestamp(new Date()))
	if (!dryRun) await mkdir(target, { recursive: true })

	for (const name of entries.sort()) {
		console.log(`${dryRun ? '[dry-run] ' : ''}${name} -> ${path.join(target, name)}`)
		if (!dryRun) await rename(path.join(OUTPUT_DIR, name), path.join(target, name))
	}

	console.log(`${dryRun ? 'Would move' : 'Moved'} ${entries.length} item(s) to ${target}/`)
}

await main()
