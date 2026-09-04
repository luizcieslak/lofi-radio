export interface Mp3FrameHeader {
	frameSize: number
	bitrate: number
	sampleRate: number
	frameDurationMs: number
}

export interface Track {
	id: string
	path: string
	title: string
	artist: string
	album?: string
	albumArtUrl?: string
	durationMs?: number
	// Platform links
	spotifyUrl?: string
	youtubeUrl?: string
	appleMusicUrl?: string
}

/**
 * A marked slice of a track, for cutting promo clips (campaign branch).
 * Stored per-filename in tracks-meta.json; deliberately not part of the public
 * `Track` served by /api/tracks — it is authoring data, not listener data.
 */
export interface Clip {
	/** Stable across playlist reorders and metadata edits. */
	id: string
	startMs: number
	endMs: number
	label?: string
}

export interface NowPlaying {
	track: Track
	startedAt: number
}

export interface PlaylistState {
	playlistOrder: string[] // Array of filenames in order
	currentTrackFilename: string | null
	currentTrackIndex: number
	lastUpdated: number
}
