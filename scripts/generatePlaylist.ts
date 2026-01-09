/**
 * PLAYLIST GENERATOR
 * ==================
 * Reads MP3 files from the songs folder and generates a playlist array
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Track } from '../src/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SONGS_DIR = path.join(__dirname, '../songs')

/**
 * Generate playlist from MP3 files in the songs folder
 */
function generatePlaylist(): Track[] {
	const files = fs.readdirSync(SONGS_DIR)
	const mp3Files = files.filter((file) => file.toLowerCase().endsWith('.mp3'))

	const playlist: Track[] = mp3Files.map((filename, index) => {
		// Remove .mp3 extension for the title
		const title = filename.replace(/\.mp3$/i, '')

		return {
			id: String(index + 1),
			path: `./songs/${filename}`,
			title,
			artist: 'Unknown Artist',
			album: 'Lofi Collection',
		}
	})

	return playlist
}

// Main execution
const playlist = generatePlaylist()

console.log('// Generated playlist:')
console.log(`// Total tracks: ${playlist.length}`)
console.log()
console.log('import type { Track } from "./types"')
console.log()
console.log('export const playlist: Track[] = ')
console.log(JSON.stringify(playlist, null, 2))
