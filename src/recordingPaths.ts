/**
 * Where scene renders land, and what each one is called (campaign branch).
 *
 * Shared by scripts/recordClips.ts, which writes the files, and the server, which
 * links each scene to its video. The link is derived from the file on disk rather
 * than stored on the scene, so it cannot go stale: archiving a render (moving it
 * into `recordings/backup/`) simply makes the link disappear.
 */

import { isTrackTheme, type TrackTheme } from './types'

/** Output folder, relative to the project root (the recorder's cwd). */
export const OUTPUT_DIR = 'recordings'

/** Vertical, the shape Shorts / Reels / TikTok actually want. */
export const WIDTH = 1080
export const HEIGHT = 1920

/**
 * Filesystem-safe name for an output file.
 *
 * Track filenames in this library include spaces, apostrophes, parentheses, and
 * full-width unicode (e.g. "ＥＬＡ　ＭＯＲＡ..."), none of which we want in a
 * filename that gets dragged into a video editor.
 */
export function slugify(input: string): string {
	return (
		input
			// NFKD splits accented and full-width characters into a base plus combining
			// marks, which \p{M} then strips — so "Café" becomes "cafe", not "caf".
			.normalize('NFKD')
			.replace(/\p{M}/gu, '')
			.replace(/\.mp3$/i, '')
			.replace(/[^a-zA-Z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.toLowerCase() || 'track'
	)
}

/**
 * The look a render was filmed in, as written in its name: the scene's resolved
 * theme (`clip.theme ?? track.theme`), or `default` when neither sets one and the
 * page used its own.
 */
export type RecordingTheme = TrackTheme | 'default'

/**
 * The render of one scene, inside OUTPUT_DIR:
 * `<track-slug>-<scene-id>-<theme>-1080x1920.mp4`. The theme is in the name so a
 * folder of renders can be sorted by look without opening them.
 */
export function recordingFilename(trackFilename: string, clipId: string, theme?: TrackTheme): string {
	return `${slugify(trackFilename)}-${clipId}-${theme ?? 'default'}-${WIDTH}x${HEIGHT}.mp4`
}

/**
 * Whether `file` is a render of this scene, and in which theme. Renders made
 * before the theme was in the name (`<slug>-<id>-1080x1920.mp4`) still match,
 * with a null theme. A scene re-rendered in another theme has one file per theme.
 */
export function parseRecordingFilename(
	file: string,
	trackFilename: string,
	clipId: string,
): { theme: RecordingTheme | null } | null {
	const prefix = `${slugify(trackFilename)}-${clipId}-`
	const suffix = `${WIDTH}x${HEIGHT}.mp4`
	if (!file.startsWith(prefix) || !file.endsWith(suffix)) return null
	const middle = file.slice(prefix.length, file.length - suffix.length)
	if (middle === '') return { theme: null }
	const theme = middle.slice(0, -1)
	if (!middle.endsWith('-') || !(theme === 'default' || isTrackTheme(theme))) return null
	return { theme }
}
