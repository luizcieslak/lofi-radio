/**
 * PLAYLIST MANAGER
 * ================
 * Manages the playlist with support for:
 * - Dynamic loading from songs folder
 * - Current track index tracking
 * - SSE notifications for track changes
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Response } from 'express'
import type { Track } from './types'

const SONGS_DIR = path.join(__dirname, '../songs')

class PlaylistManager {
	private tracks: Track[] = []
	private nextIndex: number = 0
	private playingIndex: number = 0
	private sseClients: Set<Response> = new Set()

	constructor() {
		this.loadTracksFromDisk()
	}

	private loadTracksFromDisk(): void {
		if (!fs.existsSync(SONGS_DIR)) {
			console.log('[PlaylistManager] Songs directory not found, creating...')
			fs.mkdirSync(SONGS_DIR, { recursive: true })
			this.tracks = []
			return
		}

		const files = fs.readdirSync(SONGS_DIR)
		const mp3Files = files.filter(file => file.toLowerCase().endsWith('.mp3'))

		this.tracks = mp3Files.map((filename, index) => {
			const title = filename.replace(/\.mp3$/i, '')
			return {
				id: String(index + 1),
				path: `./songs/${filename}`,
				title,
				artist: 'Unknown Artist',
				album: 'Lofi Collection',
			}
		})

		console.log(`[PlaylistManager] Loaded ${this.tracks.length} tracks`)
	}

	getTracks(): Track[] {
		return [...this.tracks]
	}

	getCurrentIndex(): number {
		return this.playingIndex
	}

	getNextTrack(): Track | undefined {
		if (this.tracks.length === 0) {
			return undefined
		}

		const track = this.tracks[this.nextIndex]
		this.nextIndex = (this.nextIndex + 1) % this.tracks.length
		return track
	}

	addSSEClient(res: Response): void {
		res.setHeader('Content-Type', 'text/event-stream')
		res.setHeader('Cache-Control', 'no-cache')
		res.setHeader('Connection', 'keep-alive')
		res.setHeader('Access-Control-Allow-Origin', '*')

		this.sseClients.add(res)
		console.log(`[PlaylistManager SSE] Client connected. Total: ${this.sseClients.size}`)

		// Send current state immediately
		const data = {
			type: 'playlist',
			tracks: this.tracks,
			currentIndex: this.playingIndex,
		}
		res.write(`data: ${JSON.stringify(data)}\n\n`)

		// Heartbeat
		const heartbeat = setInterval(() => {
			if (!res.writableEnded) {
				res.write(': heartbeat\n\n')
			}
		}, 30000)

		res.on('close', () => {
			clearInterval(heartbeat)
			this.sseClients.delete(res)
			console.log(`[PlaylistManager SSE] Client disconnected. Total: ${this.sseClients.size}`)
		})
	}

	notifyTrackChange(track: Track): void {
		const trackIndex = this.tracks.findIndex(t => t.id === track.id)
		if (trackIndex !== -1) {
			this.playingIndex = trackIndex
		}

		const data = {
			type: 'trackChange',
			track,
			currentIndex: this.playingIndex,
		}
		const message = `data: ${JSON.stringify(data)}\n\n`

		for (const client of this.sseClients) {
			try {
				if (!client.writableEnded) {
					client.write(message)
				} else {
					this.sseClients.delete(client)
				}
			} catch (err) {
				console.error('[PlaylistManager SSE] Broadcast error:', err)
				this.sseClients.delete(client)
			}
		}
	}
}

export const playlistManager = new PlaylistManager()
