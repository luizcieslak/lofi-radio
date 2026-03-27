/**
 * Metadata Manager
 *
 * Handles track metadata storage and ID3 extraction.
 * Metadata is stored in a JSON file and takes precedence over ID3 tags.
 *
 * Priority: manual override > stored metadata > ID3 tags > filename fallback
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as mm from 'music-metadata'

// Store state inside songs folder so it persists with the volume on Railway
const SONGS_DIR = path.join(__dirname, '../songs')
const STATE_DIR = path.join(SONGS_DIR, '.radio-state')
const METADATA_FILE = path.join(STATE_DIR, 'tracks-meta.json')

export interface TrackMetadata {
	title: string
	artist: string
	album?: string
	albumArtUrl?: string
	durationMs?: number
	// Source tracking
	extractedFromId3: boolean
	manuallyEdited: boolean
	lastUpdated: number
}

interface MetadataStore {
	[filename: string]: TrackMetadata
}

class MetadataManager {
	private metadata: MetadataStore = {}

	constructor() {
		this.ensureStateDir()
		this.load()
	}

	private ensureStateDir(): void {
		if (!fs.existsSync(STATE_DIR)) {
			fs.mkdirSync(STATE_DIR, { recursive: true })
		}
	}

	private load(): void {
		try {
			if (fs.existsSync(METADATA_FILE)) {
				const data = fs.readFileSync(METADATA_FILE, 'utf-8')
				this.metadata = JSON.parse(data)
				console.log(`[MetadataManager] Loaded metadata for ${Object.keys(this.metadata).length} tracks`)
			}
		} catch (err) {
			console.error('[MetadataManager] Failed to load metadata:', err)
			this.metadata = {}
		}
	}

	private save(): void {
		try {
			fs.writeFileSync(METADATA_FILE, JSON.stringify(this.metadata, null, 2))
		} catch (err) {
			console.error('[MetadataManager] Failed to save metadata:', err)
		}
	}

	/**
	 * Extract ID3 metadata from an MP3 file
	 */
	async extractFromFile(filepath: string): Promise<Partial<TrackMetadata>> {
		try {
			const metadata = await mm.parseFile(filepath)
			const { common, format } = metadata

			const extracted: Partial<TrackMetadata> = {
				extractedFromId3: true,
			}

			if (common.title) extracted.title = common.title
			if (common.artist) extracted.artist = common.artist
			if (common.album) extracted.album = common.album
			if (format.duration) extracted.durationMs = Math.round(format.duration * 1000)

			// Check for embedded album art
			if (common.picture && common.picture.length > 0) {
				// We don't store embedded art, but flag that it exists
				// In the future, could extract and upload to CDN
				const pic = common.picture[0]
				console.log(`[MetadataManager] Track has embedded album art (${pic?.format ?? 'unknown'})`)
			}

			return extracted
		} catch (err) {
			console.error(`[MetadataManager] Failed to extract ID3 from ${filepath}:`, err)
			return { extractedFromId3: false }
		}
	}

	/**
	 * Get metadata for a track, extracting from ID3 if not stored
	 */
	async getOrExtract(filename: string, filepath: string): Promise<TrackMetadata> {
		// If we have stored metadata, return it
		if (this.metadata[filename]) {
			return this.metadata[filename]
		}

		// Extract from ID3 and store
		const extracted = await this.extractFromFile(filepath)
		const titleFromFilename = path.basename(filename, '.mp3').replace(/[-_]/g, ' ')

		const meta: TrackMetadata = {
			title: extracted.title || titleFromFilename,
			artist: extracted.artist || 'Unknown Artist',
			album: extracted.album,
			albumArtUrl: undefined,
			durationMs: extracted.durationMs,
			extractedFromId3: extracted.extractedFromId3 ?? false,
			manuallyEdited: false,
			lastUpdated: Date.now(),
		}

		this.metadata[filename] = meta
		this.save()

		return meta
	}

	/**
	 * Get stored metadata (without extraction)
	 */
	get(filename: string): TrackMetadata | undefined {
		return this.metadata[filename]
	}

	/**
	 * Update metadata for a track (manual edit)
	 */
	update(
		filename: string,
		updates: Partial<Omit<TrackMetadata, 'extractedFromId3' | 'manuallyEdited' | 'lastUpdated'>>,
	): TrackMetadata {
		const existing = this.metadata[filename] || {
			title: path.basename(filename, '.mp3'),
			artist: 'Unknown Artist',
			extractedFromId3: false,
			manuallyEdited: false,
			lastUpdated: Date.now(),
		}

		this.metadata[filename] = {
			...existing,
			...updates,
			manuallyEdited: true,
			lastUpdated: Date.now(),
		}

		this.save()
		return this.metadata[filename]
	}

	/**
	 * Delete metadata for a track
	 */
	delete(filename: string): void {
		delete this.metadata[filename]
		this.save()
	}

	/**
	 * Get all stored metadata
	 */
	getAll(): MetadataStore {
		return { ...this.metadata }
	}

	/**
	 * Process a newly uploaded file - extract ID3 and store
	 */
	async processUpload(filename: string, filepath: string): Promise<TrackMetadata> {
		console.log(`[MetadataManager] Processing upload: ${filename}`)
		const meta = await this.getOrExtract(filename, filepath)
		console.log(`[MetadataManager] Extracted: title="${meta.title}", artist="${meta.artist}"`)
		return meta
	}
}

export const metadataManager = new MetadataManager()
