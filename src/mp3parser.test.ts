import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Mp3FrameReader } from './mp3parser'

/**
 * `songs/` is gitignored, so the suite generates its own fixture instead of
 * depending on the user's library. Encoded VBR (libmp3lame V0) at the canonical
 * 44100 Hz / stereo to match production tracks — VBR matters because it is the
 * variable frame size that makes byte-ratio seeking wrong and the frame walk
 * necessary.
 */
const FIXTURE_SECONDS = 12
// A single MPEG1 Layer III frame is 1152/44100 s ≈ 26.12ms, so a seek can only
// land on a frame boundary. Assertions allow one frame of slack.
const FRAME_MS = (1152 / 44100) * 1000
let fixtureDir: string
let fixturePath: string

beforeAll(() => {
	fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3parser-test-'))
	fixturePath = path.join(fixtureDir, 'fixture.mp3')

	const result = spawnSync(
		'ffmpeg',
		[
			'-f',
			'lavfi',
			'-i',
			`sine=frequency=440:sample_rate=44100:duration=${FIXTURE_SECONDS}`,
			'-ac',
			'2',
			'-codec:a',
			'libmp3lame',
			'-q:a',
			'0',
			'-y',
			fixturePath,
		],
		{ encoding: 'utf-8' },
	)

	if (result.status !== 0) {
		throw new Error(`Failed to generate MP3 fixture: ${result.stderr}`)
	}
})

afterAll(() => {
	fs.rmSync(fixtureDir, { recursive: true, force: true })
})

/**
 * Read one frame, failing the test if there isn't one. Keeps assertions working on
 * a definite Buffer rather than `Buffer | undefined` (tsconfig sets
 * noUncheckedIndexedAccess and readNextFrame is nullable at EOF).
 */
function readFrameData(reader: Mp3FrameReader): Buffer {
	const frame = reader.readNextFrame()
	if (!frame) throw new Error('Expected a frame, got EOF')
	return frame.data
}

describe('Mp3FrameReader.getDurationMs', () => {
	test('measures the encoded duration', () => {
		const reader = new Mp3FrameReader(fixturePath)
		try {
			// LAME pads with a few encoder-delay frames, so the frame-sum duration runs
			// slightly over the requested length. Assert the bound, not an exact value.
			const durationMs = reader.getDurationMs()
			const nominalMs = FIXTURE_SECONDS * 1000
			expect(durationMs).toBeGreaterThanOrEqual(nominalMs)
			expect(durationMs - nominalMs).toBeLessThan(5 * FRAME_MS)
		} finally {
			reader.close()
		}
	})

	test('does not disturb the read position', () => {
		const reader = new Mp3FrameReader(fixturePath)
		try {
			reader.readNextFrame()
			reader.readNextFrame()
			const positionBefore = reader.getPositionMs()
			const frameBefore = readFrameData(reader)

			// Re-read the same frame after a duration walk to prove the walk restored state.
			const readerAgain = new Mp3FrameReader(fixturePath)
			try {
				readerAgain.readNextFrame()
				readerAgain.readNextFrame()
				readerAgain.getDurationMs()
				expect(readerAgain.getPositionMs()).toBe(positionBefore)
				expect(readFrameData(readerAgain)).toEqual(frameBefore)
			} finally {
				readerAgain.close()
			}
		} finally {
			reader.close()
		}
	})
})

describe('Mp3FrameReader.seekToMs', () => {
	test('lands within one frame of the requested position', () => {
		const reader = new Mp3FrameReader(fixturePath)
		try {
			for (const target of [0, 1000, 3500, 7000, 11000]) {
				const landed = reader.seekToMs(target)
				expect(landed).toBeGreaterThanOrEqual(target)
				expect(landed - target).toBeLessThan(FRAME_MS)
				expect(reader.getPositionMs()).toBe(landed)
			}
		} finally {
			reader.close()
		}
	})

	test('is monotonic across increasing targets', () => {
		const reader = new Mp3FrameReader(fixturePath)
		try {
			let previous = -1
			for (const target of [0, 500, 2000, 4000, 6000, 9000]) {
				const landed = reader.seekToMs(target)
				expect(landed).toBeGreaterThan(previous)
				previous = landed
			}
		} finally {
			reader.close()
		}
	})

	test('is repeatable — seeking to the same target yields the same frame', () => {
		const reader = new Mp3FrameReader(fixturePath)
		try {
			reader.seekToMs(5000)
			const first = readFrameData(reader)

			// Seek away, then back.
			reader.seekToMs(1000)
			reader.seekToMs(5000)
			const second = readFrameData(reader)

			expect(second).toEqual(first)
		} finally {
			reader.close()
		}
	})

	test('clamps past EOF to the track duration rather than running away', () => {
		const reader = new Mp3FrameReader(fixturePath)
		try {
			const duration = reader.getDurationMs()
			const landed = reader.seekToMs(duration + 60_000)

			expect(landed).toBeCloseTo(duration, -2)
			expect(landed).toBeLessThanOrEqual(duration)
			// At EOF there is nothing left to read.
			expect(reader.readNextFrame()).toBeNull()
		} finally {
			reader.close()
		}
	})

	test('treats negative targets as 0', () => {
		const reader = new Mp3FrameReader(fixturePath)
		try {
			expect(reader.seekToMs(-5000)).toBe(0)
			expect(reader.getPositionMs()).toBe(0)
		} finally {
			reader.close()
		}
	})

	test('seeking back to 0 replays the very first frame', () => {
		const reader = new Mp3FrameReader(fixturePath)
		try {
			const firstFrame = readFrameData(reader)
			reader.seekToMs(4000)
			reader.seekToMs(0)

			expect(reader.getPositionMs()).toBe(0)
			expect(readFrameData(reader)).toEqual(firstFrame)
		} finally {
			reader.close()
		}
	})
})

describe('Mp3FrameReader.getPositionMs', () => {
	test('advances by each consumed frame duration', () => {
		const reader = new Mp3FrameReader(fixturePath)
		try {
			expect(reader.getPositionMs()).toBe(0)

			let expected = 0
			for (let i = 0; i < 20; i++) {
				const frame = reader.readNextFrame()
				expect(frame).not.toBeNull()
				expected += frame?.header.frameDurationMs ?? 0
				expect(reader.getPositionMs()).toBeCloseTo(expected, 6)
			}
		} finally {
			reader.close()
		}
	})
})
