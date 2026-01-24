/**
 * PLAYLIST MANAGER
 * ================
 * Manages the playlist with support for:
 * - Dynamic loading from songs folder
 * - Track reordering
 * - Current track index tracking
 * - SSE notifications for playlist changes
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Response } from 'express'
import type { Track } from './types'

const SONGS_DIR = path.join(__dirname, '../songs')

class PlaylistManager {
	private tracks: Track[] = []
	private currentIndex: number = 0
	private sseClients: Set<Response> = new Set()

	constructor() {
		this.loadTracksFromDisk()
	}

	/**
	 * Load MP3 files from the songs directory
	 */
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

	/**
	 * Get all tracks in current order
	 */
	getTracks(): Track[] {
		return [...this.tracks]
	}

	/**
	 * Get the current track index
	 */
	getCurrentIndex(): number {
		return this.currentIndex
	}

	/**
	 * Get the currently playing track
	 */
	getCurrentTrack(): Track | undefined {
		return this.tracks[this.currentIndex]
	}

	/**
	 * Get the next track and advance the index
	 */
	getNextTrack(): Track | undefined {
		if (this.tracks.length === 0) {
			return undefined
		}

		const track = this.tracks[this.currentIndex]
		this.currentIndex = (this.currentIndex + 1) % this.tracks.length
		return track
	}

	/**
	 * Reorder tracks based on an array of track IDs
	 */
	reorderTracks(trackIds: string[]): boolean {
		// Validate that all IDs exist
		const trackMap = new Map(this.tracks.map(t => [t.id, t]))

		const newOrder: Track[] = []
		for (const id of trackIds) {
			const track = trackMap.get(id)
			if (!track) {
				console.error(`[PlaylistManager] Track ID not found: ${id}`)
				return false
			}
			newOrder.push(track)
		}

		// Check if all tracks are included
		if (newOrder.length !== this.tracks.length) {
			console.error('[PlaylistManager] Reorder must include all tracks')
			return false
		}

		// Get the currently playing track before reordering
		const currentTrack = this.tracks[this.currentIndex]

		// Apply new order
		this.tracks = newOrder

		// Find the new index of the currently playing track
		if (currentTrack) {
			const newIndex = this.tracks.findIndex(t => t.id === currentTrack.id)
			if (newIndex !== -1) {
				this.currentIndex = newIndex
			}
		}

		console.log('[PlaylistManager] Playlist reordered')
		this.broadcastPlaylistUpdate()
		return true
	}

	/**
	 * Add an SSE client for playlist updates
	 */
	addSSEClient(res: Response): void {
		res.setHeader('Content-Type', 'text/event-stream')
		res.setHeader('Cache-Control', 'no-cache')
		res.setHeader('Connection', 'keep-alive')
		res.setHeader('Access-Control-Allow-Origin', '*')

		this.sseClients.add(res)
		console.log(`[PlaylistManager SSE] Client connected. Total: ${this.sseClients.size}`)

		// Send current state immediately
		this.sendPlaylistState(res)

		// Heartbeat to keep connection alive
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

	/**
	 * Send playlist state to a single client
	 */
	private sendPlaylistState(res: Response): void {
		const data = {
			type: 'playlist',
			tracks: this.tracks,
			currentIndex: this.currentIndex,
		}
		if (!res.writableEnded) {
			res.write(`data: ${JSON.stringify(data)}\n\n`)
		}
	}

	/**
	 * Broadcast playlist update to all SSE clients
	 */
	private broadcastPlaylistUpdate(): void {
		const data = {
			type: 'playlist',
			tracks: this.tracks,
			currentIndex: this.currentIndex,
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

	/**
	 * Notify clients that the current track has changed
	 */
	notifyTrackChange(track: Track): void {
		// Find the track index
		const index = this.tracks.findIndex(t => t.id === track.id)
		if (index !== -1) {
			this.currentIndex = index
		}

		const data = {
			type: 'trackChange',
			track,
			currentIndex: this.currentIndex,
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
				console.error('[PlaylistManager SSE] Track change broadcast error:', err)
				this.sseClients.delete(client)
			}
		}
	}

	/**
	 * Reload tracks from disk
	 */
	reload(): void {
		this.loadTracksFromDisk()
		this.currentIndex = 0
		this.broadcastPlaylistUpdate()
	}
}

// Export singleton instance
export const playlistManager = new PlaylistManager()
