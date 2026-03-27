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
