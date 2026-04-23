/**
 * PLAYLIST MANAGER
 * ================
 * Manages the playlist with support for:
 * - Dynamic loading from songs folder
 * - Current track index tracking
 * - SSE notifications for track changes
 * - Reactive add/remove without interrupting playback
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Response } from 'express'
import { metadataManager } from './metadataManager'
import type { PlaylistState, Track } from './types'

const SONGS_DIR = path.join(__dirname, '../songs')
// Store state inside songs folder so it persists with the volume on Railway
const STATE_DIR = path.join(SONGS_DIR, '.radio-state')
const STATE_FILE = path.join(STATE_DIR, 'state.json')

// Callback type for when current track needs to be skipped
type SkipCallback = () => void

class PlaylistManager {
	private tracks: Track[] = []
	private nextIndex: number = 0
	private playingIndex: number = 0
	private sseClients: Set<Response> = new Set()
	private onSkipCurrentTrack: SkipCallback | null = null

	constructor() {
		this.loadTracksFromDisk()
		this.loadState()
	}

	/**
	 * Register a callback to be called when the current track needs to be skipped
	 * (e.g., when it's deleted while playing)
	 */
	setSkipCallback(callback: SkipCallback): void {
		this.onSkipCurrentTrack = callback
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
			// Try to get stored metadata, fallback to filename
			const meta = metadataManager.get(filename)
			const fallbackTitle = filename.replace(/\.mp3$/i, '').replace(/[-_]/g, ' ')

			return {
				id: String(index + 1),
				path: `./songs/${filename}`,
				title: meta?.title || fallbackTitle,
				artist: meta?.artist || 'Unknown Artist',
				album: meta?.album || undefined,
				albumArtUrl: meta?.albumArtUrl || undefined,
				durationMs: meta?.durationMs || undefined,
				spotifyUrl: meta?.spotifyUrl || undefined,
				youtubeUrl: meta?.youtubeUrl || undefined,
				appleMusicUrl: meta?.appleMusicUrl || undefined,
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

	/**
	 * Rescan songs directory and reload tracks
	 * Useful for manual full refresh
	 */
	rescan(): void {
		console.log('[PlaylistManager] Rescanning songs directory...')
		this.loadTracksFromDisk()
		this.broadcastPlaylistUpdate()
		console.log(`[PlaylistManager] Rescan complete: ${this.tracks.length} tracks`)
	}

	/**
	 * Add a single track to the playlist without interrupting playback
	 * Called when a new song is uploaded
	 */
	addTrack(filename: string): void {
		// Check if track already exists
		const existingIndex = this.tracks.findIndex(t => path.basename(t.path) === filename)
		if (existingIndex !== -1) {
			console.log(`[PlaylistManager] Track already exists: ${filename}`)
			return
		}

		// Get metadata
		const meta = metadataManager.get(filename)
		const fallbackTitle = filename.replace(/\.mp3$/i, '').replace(/[-_]/g, ' ')

		// Create new track with next available ID
		const maxId = this.tracks.reduce((max, t) => Math.max(max, parseInt(t.id, 10) || 0), 0)
		const newTrack: Track = {
			id: String(maxId + 1),
			path: `./songs/${filename}`,
			title: meta?.title || fallbackTitle,
			artist: meta?.artist || 'Unknown Artist',
			album: meta?.album || undefined,
			albumArtUrl: meta?.albumArtUrl || undefined,
			durationMs: meta?.durationMs || undefined,
			spotifyUrl: meta?.spotifyUrl || undefined,
			youtubeUrl: meta?.youtubeUrl || undefined,
			appleMusicUrl: meta?.appleMusicUrl || undefined,
		}

		// Add to end of playlist
		this.tracks.push(newTrack)
		console.log(`[PlaylistManager] Added track: ${filename} (total: ${this.tracks.length})`)

		// Save state and notify clients
		this.saveState()
		this.broadcastPlaylistUpdate()
	}

	/**
	 * Remove a track from the playlist without interrupting playback
	 * If the currently playing track is removed, triggers skip to next track
	 * Called when a song is deleted
	 */
	removeTrack(filename: string): void {
		const trackIndex = this.tracks.findIndex(t => path.basename(t.path) === filename)

		if (trackIndex === -1) {
			console.log(`[PlaylistManager] Track not found: ${filename}`)
			return
		}

		const isCurrentlyPlaying = trackIndex === this.playingIndex
		const wasBeforeCurrent = trackIndex < this.playingIndex

		// Remove the track
		this.tracks.splice(trackIndex, 1)
		console.log(`[PlaylistManager] Removed track: ${filename} (remaining: ${this.tracks.length})`)

		// Adjust indices
		if (wasBeforeCurrent) {
			// Track removed before current: shift indices back
			this.playingIndex = Math.max(0, this.playingIndex - 1)
			this.nextIndex = Math.max(0, this.nextIndex - 1)
		} else if (isCurrentlyPlaying) {
			// Currently playing track was removed
			// Keep playingIndex the same (now points to what was the next track)
			// But ensure it's valid
			if (this.playingIndex >= this.tracks.length) {
				this.playingIndex = 0
			}
			if (this.nextIndex >= this.tracks.length) {
				this.nextIndex = 0
			}
		}

		// Ensure nextIndex is valid
		if (this.nextIndex >= this.tracks.length) {
			this.nextIndex = 0
		}

		// Save state and notify clients
		this.saveState()
		this.broadcastPlaylistUpdate()

		// If the currently playing track was removed, trigger skip
		if (isCurrentlyPlaying && this.onSkipCurrentTrack) {
			console.log('[PlaylistManager] Currently playing track was deleted, triggering skip...')
			this.onSkipCurrentTrack()
		}
	}

	/**
	 * Get the currently playing track (for skip detection)
	 */
	getCurrentTrack(): Track | undefined {
		return this.tracks[this.playingIndex]
	}

	/**
	 * Broadcast playlist update to all SSE clients
	 */
	private broadcastPlaylistUpdate(): void {
		const data = {
			type: 'playlist',
			tracks: this.tracks,
			currentIndex: this.playingIndex,
		}
		const message = `data: ${JSON.stringify(data)}\n\n`

		for (const client of this.sseClients) {
			try {
				if (!client.writableEnded) {
					client.write(message)
				}
			} catch (err) {
				console.error('[PlaylistManager SSE] Broadcast error:', err)
				this.sseClients.delete(client)
			}
		}
	}

	peekNextTrack(): Track | undefined {
		if (this.tracks.length === 0) {
			return undefined
		}

		return this.tracks[this.nextIndex]
	}

	commitNextTrack(): Track | undefined {
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

			const currentTrack = this.tracks[this.playingIndex]
			const state: PlaylistState = {
				playlistOrder,
				currentTrackFilename: currentTrack ? path.basename(currentTrack.path) : null,
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
			// Try to get stored metadata, fallback to filename
			const meta = metadataManager.get(filename)
			const fallbackTitle = filename.replace(/\.mp3$/i, '').replace(/[-_]/g, ' ')

			return {
				id: String(index + 1),
				path: `./songs/${filename}`,
				title: meta?.title || fallbackTitle,
				artist: meta?.artist || 'Unknown Artist',
				album: meta?.album || undefined,
				albumArtUrl: meta?.albumArtUrl || undefined,
				durationMs: meta?.durationMs || undefined,
				spotifyUrl: meta?.spotifyUrl || undefined,
				youtubeUrl: meta?.youtubeUrl || undefined,
				appleMusicUrl: meta?.appleMusicUrl || undefined,
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
