import fs from 'node:fs'
import type { Mp3FrameHeader } from './types'

/**
 * Bitrate lookup table for MPEG1 Layer 3
 * Index comes from 4 bits in the frame header
 */
const BITRATE_TABLE: (number | null)[] = [
	null, // 0000 - reserved
	32, // 0001
	40, // 0010
	48, // 0011
	56, // 0100
	64, // 0101
	80, // 0110
	96, // 0111
	112, // 1000
	128, // 1001
	160, // 1010
	192, // 1011
	224, // 1100
	256, // 1101
	320, // 1110
	null, // 1111 - reserved
]

/**
 * Sample rate lookup table for MPEG1
 */
const SAMPLE_RATE_TABLE: (number | null)[] = [
	44100, // 00
	48000, // 01
	32000, // 10
	null, // 11 - reserved
]

/**
 * Parse an MP3 frame header from 4 bytes
 *
 * Frame header structure:
 * - Byte 0: 0xFF (sync)
 * - Byte 1: 111AABBC (sync continued, version, layer, protection)
 * - Byte 2: DDDDEEEF (bitrate, sample rate, padding)
 * - Byte 3: GGHHJJKK (channel mode, etc.)
 */
function parseFrameHeader(header: Buffer): Mp3FrameHeader | null {
	// Check sync word: first byte must be 0xFF, top 3 bits of second byte must be 1s
	if (header[0] !== 0xff || (header[1]! & 0xe0) !== 0xe0) {
		return null
	}

	// Extract MPEG version (bits 4-3 of byte 1)
	const mpegVersion = (header[1]! >> 3) & 0x03
	if (mpegVersion === 1) return null // Reserved

	// Extract layer (bits 2-1 of byte 1)
	const layer = (header[1]! >> 1) & 0x03
	if (layer === 0) return null // Reserved

	// Extract bitrate index (bits 7-4 of byte 2)
	const bitrateIndex = (header[2]! >> 4) & 0x0f
	const bitrate = BITRATE_TABLE[bitrateIndex]
	if (!bitrate) return null

	// Extract sample rate index (bits 3-2 of byte 2)
	const sampleRateIndex = (header[2]! >> 2) & 0x03
	const sampleRate = SAMPLE_RATE_TABLE[sampleRateIndex]
	if (!sampleRate) return null

	// Extract padding bit (bit 1 of byte 2)
	const padding = (header[2]! >> 1) & 0x01

	// Calculate frame size for MPEG1 Layer 3
	const frameSize = Math.floor((144 * bitrate * 1000) / sampleRate) + padding

	// Calculate frame duration (1152 samples per frame for MPEG1 Layer 3)
	const frameDurationMs = (1152 / sampleRate) * 1000

	return { frameSize, bitrate, sampleRate, frameDurationMs }
}

// ============================================================================
// MP3 FRAME READER
// ============================================================================

class Mp3FrameReader {
	private fd: number
	private position: number = 0
	private fileSize: number

	constructor(filePath: string) {
		this.fd = fs.openSync(filePath, 'r')
		this.fileSize = fs.fstatSync(this.fd).size
		this.skipId3v2Tag()
	}

	/**
	 * Skip ID3v2 tag at the beginning of the file if present
	 */
	private skipId3v2Tag(): void {
		const header = Buffer.alloc(10)
		fs.readSync(this.fd, header, 0, 10, 0)

		if (header.toString('ascii', 0, 3) === 'ID3') {
			// ID3v2 size is a "synchsafe" integer (7 bits per byte)
			const size =
				((header[6]! & 0x7f) << 21) |
				((header[7]! & 0x7f) << 14) |
				((header[8]! & 0x7f) << 7) |
				(header[9]! & 0x7f)

			this.position = 10 + size
			console.log(`[Mp3Reader] Skipped ID3v2 tag: ${this.position} bytes`)
		}
	}

	/**
	 * Read the next MP3 frame from the file
	 */
	readNextFrame(): { data: Buffer; header: Mp3FrameHeader } | null {
		if (this.position >= this.fileSize) {
			return null
		}

		// Read potential frame header (4 bytes)
		const headerBuf = Buffer.alloc(4)
		const bytesRead = fs.readSync(this.fd, headerBuf, 0, 4, this.position)

		if (bytesRead < 4) {
			return null
		}

		// Try to parse as frame header
		const header = parseFrameHeader(headerBuf)

		if (!header) {
			// Not a valid frame header, skip one byte and try again
			// This handles garbage data between frames
			this.position++
			return this.readNextFrame()
		}

		// Read the full frame (including header)
		const frameData = Buffer.alloc(header.frameSize)
		fs.readSync(this.fd, frameData, 0, header.frameSize, this.position)

		this.position += header.frameSize

		return { data: frameData, header }
	}

	close(): void {
		fs.closeSync(this.fd)
	}

	reset(): void {
		this.position = 0
		this.skipId3v2Tag()
	}
}

// ============================================================================
// PRECISE TIMER
// ============================================================================

/**
 * Precise timing using process.hrtime for nanosecond accuracy
 *
 * Standard setTimeout has ~4ms minimum delay and can drift.
 * For audio streaming, we need much better precision.
 */
class PreciseTimer {
	private startTime: bigint = process.hrtime.bigint()
	private elapsedTargetMs: number = 0

	/**
	 * Add time to our "budget" - how much time should have elapsed
	 */
	addTime(ms: number): void {
		this.elapsedTargetMs += ms
	}

	/**
	 * Calculate how long we should wait before sending the next frame
	 */
	getDelayMs(): number {
		const actualElapsedNs = process.hrtime.bigint() - this.startTime
		const actualElapsedMs = Number(actualElapsedNs) / 1_000_000
		return Math.max(0, this.elapsedTargetMs - actualElapsedMs)
	}

	/**
	 * Wait until it's time to send the next frame
	 */
	async wait(): Promise<void> {
		const delay = this.getDelayMs()

		if (delay > 1) {
			// Use setTimeout for longer waits (saves CPU)
			await new Promise(resolve => setTimeout(resolve, delay - 1))
		}

		// Busy-wait for final sub-millisecond precision
		while (this.getDelayMs() > 0) {
			// Spin
		}
	}

	reset(): void {
		this.startTime = process.hrtime.bigint()
		this.elapsedTargetMs = 0
	}
}

export { Mp3FrameReader, PreciseTimer }
