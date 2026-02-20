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
import type { PlaylistState, Track } from './types'

const SONGS_DIR = path.join(__dirname, '../songs')
const STATE_FILE = path.join(__dirname, 'state/state.json')

class PlaylistManager {
	private tracks: Track[] = []
	private nextIndex: number = 0
	private playingIndex: number = 0
	private sseClients: Set<Response> = new Set()

	constructor() {
		this.loadTracksFromDisk()
		this.loadState()
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

		// Persist state after track change
		this.saveState()
	}

	/**
	 * Load persisted state from disk
	 */
	private loadState(): void {
		try {
			if (!fs.existsSync(STATE_FILE)) {
				console.log('[PlaylistManager] No state file found, starting fresh')
				return
			}

			const stateData = fs.readFileSync(STATE_FILE, 'utf-8')
			const state: PlaylistState = JSON.parse(stateData)

			console.log('[PlaylistManager] Loading state from', STATE_FILE)
			this.reconcilePlaylist(state)
		} catch (err) {
			console.error('[PlaylistManager] Failed to load state:', err)
			console.log('[PlaylistManager] Starting with fresh state')
		}
	}

	/**
	 * Save current state to disk
	 */
	private saveState(): void {
		try {
			// Ensure state directory exists
			const stateDir = path.dirname(STATE_FILE)
			if (!fs.existsSync(stateDir)) {
				fs.mkdirSync(stateDir, { recursive: true })
			}

			// Extract filenames from current playlist
			const playlistOrder = this.tracks.map(track => path.basename(track.path))

			const state: PlaylistState = {
				playlistOrder,
				currentTrackFilename:
					this.playingIndex >= 0 && this.playingIndex < this.tracks.length
						? path.basename(this.tracks[this.playingIndex].path)
						: null,
				currentTrackIndex: this.playingIndex,
				lastUpdated: Date.now(),
			}

			fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
			console.log('[PlaylistManager] State saved:', state.currentTrackFilename)
		} catch (err) {
			console.error('[PlaylistManager] Failed to save state:', err)
		}
	}

	/**
	 * Reconcile saved playlist state with current disk contents
	 */
	private reconcilePlaylist(state: PlaylistState): void {
		console.log('[PlaylistManager] Reconciling playlist...')

		// Get current files on disk
		const diskFiles = new Set(this.tracks.map(t => path.basename(t.path)))
		const savedOrder = state.playlistOrder

		// Build reconciled playlist
		const reconciledFilenames: string[] = []

		// 1. Add songs from saved order that still exist on disk
		for (const filename of savedOrder) {
			if (diskFiles.has(filename)) {
				reconciledFilenames.push(filename)
				diskFiles.delete(filename) // Mark as processed
			} else {
				console.log(`[PlaylistManager] Skipping missing file: ${filename}`)
			}
		}

		// 2. Append new songs found on disk (not in saved order)
		for (const newFile of diskFiles) {
			console.log(`[PlaylistManager] Adding new file: ${newFile}`)
			reconciledFilenames.push(newFile)
		}

		// 3. Rebuild tracks array with reconciled order
		this.tracks = reconciledFilenames.map((filename, index) => {
			const title = filename.replace(/\.mp3$/i, '')
			return {
				id: String(index + 1),
				path: `./songs/${filename}`,
				title,
				artist: 'Unknown Artist',
				album: 'Lofi Collection',
			}
		})

		// 4. Find current track index
		if (state.currentTrackFilename) {
			const resumeIndex = reconciledFilenames.indexOf(state.currentTrackFilename)
			if (resumeIndex !== -1) {
				this.nextIndex = resumeIndex
				this.playingIndex = resumeIndex
				console.log(`[PlaylistManager] Resuming from: ${state.currentTrackFilename} (index ${resumeIndex})`)
			} else {
				console.log('[PlaylistManager] Current track not found, starting from beginning')
				this.nextIndex = 0
				this.playingIndex = 0
			}
		}

		console.log(`[PlaylistManager] Reconciliation complete: ${this.tracks.length} tracks`)
	}
}

export const playlistManager = new PlaylistManager()
