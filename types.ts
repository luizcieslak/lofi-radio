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
}

export interface NowPlaying {
	track: Track
	startedAt: number
}
