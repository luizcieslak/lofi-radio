import { join } from 'path'
import { readdir } from 'node:fs/promises'

type Song = {
	path: string
	name: string
	buffer: ArrayBuffer // Add buffer to the type
	duration: number // We'll need this for timing
	metadata: {
		title: string
		artist: string
		album: string
		albumCover: string
	}
}

type StationState = {
	songs: Song[]
	currentSongIndex: number
	currentSongStartTime: number
	isPlaying: boolean
}

const createInitialState = (): StationState => ({
	songs: [],
	currentSongIndex: 0,
	currentSongStartTime: Date.now(),
	isPlaying: false,
})

const loadSongs = async (songsDir: string): Promise<Song[]> => {
	const files = await readdir(songsDir)

	const loadSong = async (file: string): Promise<Song | null> => {
		if (!file.endsWith('.mp3')) return null

		const path = join(songsDir, file)
		const fileBuffer = await Bun.file(path).arrayBuffer()

		return {
			path,
			name: file.replace('.mp3', ''),
			buffer: fileBuffer,
			duration: 0, // Would need implementation
			metadata: {
				title: file.replace('.mp3', ''),
				artist: 'Unknown',
				album: 'Unknown',
				albumCover: 'https://placeholder.com/album.jpg',
			},
		}
	}

	const songPromises = files.map(loadSong)
	const songs = (await Promise.all(songPromises)).filter((song): song is Song => song !== null)

	return songs
}

// Pure functions for state updates
const nextSong = (state: StationState): StationState => ({
	...state,
	currentSongIndex: (state.currentSongIndex + 1) % state.songs.length,
	currentSongStartTime: Date.now(),
})

const startPlaying = (state: StationState): StationState => ({
	...state,
	isPlaying: true,
})

// Pure functions for queries
const getCurrentSong = (state: StationState): Song | null => state.songs[state.currentSongIndex] || null

const getCurrentBuffer = (state: StationState): ArrayBuffer | null => getCurrentSong(state)?.buffer || null

const getCurrentMetadata = (state: StationState) => getCurrentSong(state)?.metadata || null

// Side effects are isolated
const scheduleNextSong = (
	state: StationState,
	onStateChange: (newState: StationState) => void,
	onMetadataChange: () => void
) => {
	const currentSong = getCurrentSong(state)
	if (!currentSong) return

	setTimeout(() => {
		const newState = nextSong(state)
		onStateChange(newState)
		onMetadataChange()
		scheduleNextSong(newState, onStateChange, onMetadataChange)
	}, currentSong.duration)
}

// Usage example (this would be your main station controller)
const initializeStation = async () => {
	let state = createInitialState()

	// Load songs
	const songs = await loadSongs(join(import.meta.dir, 'songs'))
	state = { ...state, songs }

	// Start playing
	state = startPlaying(state)

	// Handle state changes
	const handleStateChange = (newState: StationState) => {
		state = newState
	}

	const handleMetadataChange = () => {
		// Will implement with SSE
	}

	// Start scheduling
	scheduleNextSong(state, handleStateChange, handleMetadataChange)

	// Return functions to interact with the station
	return {
		getCurrentSong: () => getCurrentSong(state),
		getCurrentBuffer: () => getCurrentBuffer(state),
		getCurrentMetadata: () => getCurrentMetadata(state),
	}
}

async function getSongs(): Promise<Song[]> {
	const songsDir = join(import.meta.dir, 'songs')
	const files = await readdir(songsDir)

	return files
		.filter(file => file.endsWith('.mp3'))
		.map(file => ({
			path: join(songsDir, file),
			name: file.replace('.mp3', ''),
		}))
}

let songs: Song[] = []
let audioBuffer: ArrayBuffer | null = null

async function initialize() {
	songs = await getSongs()
	console.log(`Loaded ${songs.length} songs`)

	const buffers: ArrayBuffer[] = []
	for (const song of songs) {
		const file = Bun.file(song.path)
		const buffer = await file.arrayBuffer()
		buffers.push(buffer)
	}
	audioBuffer = concatenateArrayBuffers(buffers)
	console.log('Audio buffer created')
}

// Helper function to concatenate ArrayBuffers
function concatenateArrayBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
	const totalLength = buffers.reduce((acc, buf) => acc + buf.byteLength, 0)
	const result = new Uint8Array(totalLength)
	let offset = 0

	for (const buffer of buffers) {
		result.set(new Uint8Array(buffer), offset)
		offset += buffer.byteLength
	}

	return result.buffer
}

// Initialize the server
await initialize()

const server = Bun.serve({
	port: 5634,
	routes: {
		'/stream': () => {
			if (!audioBuffer) {
				return new Response('Audio not ready', { status: 503 })
			}

			return new Response(audioBuffer, {
				headers: {
					'Content-Type': 'audio/mpeg',
					'Accept-Ranges': 'bytes',
					'Cache-Control': 'no-cache',
					'Access-Control-Allow-Origin': '*',
				},
			})
		},
		'/test': () => {
			const html = `
			<!DOCTYPE html>
			<html>
					<head>
							<title>Lofi Radio</title>
					</head>
					<body>
							<h1>Lofi Radio Player</h1>
							<audio controls autoplay>
									<source src="/stream" type="audio/mpeg">
									Your browser does not support the audio element.
							</audio>
					</body>
			</html>
	`
			return new Response(html, {
				headers: {
					'Content-Type': 'text/html',
				},
			})
		},
	},
})

console.log(`Listening on http://localhost:${server.port} ...`)
