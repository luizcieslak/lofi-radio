export interface Mp3FrameHeader {
	frameSize: number
	bitrate: number
	sampleRate: number
	frameDurationMs: number
}

/**
 * Which way a player should style itself while this track is playing.
 *
 * A closed union rather than `string` so a typo can't reach the player as an
 * unstyleable value, and so `undefined` stays meaningful: absent = "no opinion,
 * use your own default", which is distinct from an explicit 'light'.
 */
export type TrackTheme = 'light' | 'dark'

export const TRACK_THEMES: readonly TrackTheme[] = ['light', 'dark']

export function isTrackTheme(value: unknown): value is TrackTheme {
	return typeof value === 'string' && TRACK_THEMES.some(theme => theme === value)
}

export interface Track {
	id: string
	path: string
	title: string
	artist: string
	album?: string
	albumArtUrl?: string
	durationMs?: number
	/** Preferred player styling for this track; undefined = player's default. */
	theme?: TrackTheme
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
