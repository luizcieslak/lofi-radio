/**
 * Where scene renders land, and what each one is called (campaign branch).
 *
 * Shared by scripts/recordClips.ts, which writes the files, and the server, which
 * links each scene to its video. The link is derived from the file on disk rather
 * than stored on the scene, so it cannot go stale: archiving a render (moving it
 * into `recordings/backup/`) simply makes the link disappear.
 */

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

/** The render of one scene: `<track-slug>-<scene-id>-1080x1920.mp4`, inside OUTPUT_DIR. */
export function recordingFilename(trackFilename: string, clipId: string): string {
	return `${slugify(trackFilename)}-${clipId}-${WIDTH}x${HEIGHT}.mp4`
}
