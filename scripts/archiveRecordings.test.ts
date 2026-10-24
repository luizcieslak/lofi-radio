import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { archiveRecordings } from './archiveRecordings'

let dir = ''
const now = new Date(2026, 9, 23, 14, 5, 9)

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'archive-'))
})

afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

describe('archiveRecordings', () => {
	test('moves renders into a stamped backup folder, leaving backup/ and dot entries', async () => {
		await writeFile(path.join(dir, 'b.mp4'), '')
		await writeFile(path.join(dir, 'a.mp4'), '')
		await mkdir(path.join(dir, '.work-x'))
		await mkdir(path.join(dir, 'backup'))

		const result = await archiveRecordings({ outputDir: dir, now })

		expect(result).toEqual({
			moved: ['a.mp4', 'b.mp4'],
			target: path.join(dir, 'backup', '2026-10-23T14-05-09'),
		})
		expect((await readdir(dir)).sort()).toEqual(['.work-x', 'backup'])
		expect((await readdir(result.target ?? '')).sort()).toEqual(['a.mp4', 'b.mp4'])
	})

	test('a dry run moves nothing', async () => {
		await writeFile(path.join(dir, 'a.mp4'), '')
		const result = await archiveRecordings({ outputDir: dir, now, dryRun: true })
		expect(result.moved).toEqual(['a.mp4'])
		expect(await readdir(dir)).toEqual(['a.mp4'])
	})

	test('a second run in the same second gets its own folder', async () => {
		await writeFile(path.join(dir, 'a.mp4'), '')
		await archiveRecordings({ outputDir: dir, now })
		await writeFile(path.join(dir, 'b.mp4'), '')
		const second = await archiveRecordings({ outputDir: dir, now })
		expect(second.target).toBe(path.join(dir, 'backup', '2026-10-23T14-05-09-2'))
	})

	test('nothing to move, or no folder at all', async () => {
		expect(await archiveRecordings({ outputDir: dir, now })).toEqual({ moved: [], target: null })
		expect(await archiveRecordings({ outputDir: path.join(dir, 'missing'), now })).toEqual({
			moved: [],
			target: null,
		})
	})
})
