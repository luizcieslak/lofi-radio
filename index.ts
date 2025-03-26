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
	sseClients: Set<WritableStreamDefaultWriter>
}

const createInitialState = (): StationState => ({
	songs: [],
	currentSongIndex: 0,
	currentSongStartTime: Date.now(),
	isPlaying: false,
	sseClients: new Set(),
})

// Pure function to load songs
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

// Pure function to create metadata message
const createMetadataMessage = (song: Song | null) => ({
	type: 'metadata',
	data: song?.metadata ?? null,
	timestamp: Date.now(),
})

// SSE management functions
const addSSEClient = (state: StationState, client: WritableStreamDefaultWriter): StationState => ({
	...state,
	sseClients: new Set([...state.sseClients, client]),
})

const removeSSEClient = (state: StationState, client: WritableStreamDefaultWriter): StationState => {
	const newClients = new Set(state.sseClients)
	newClients.delete(client)
	return {
		...state,
		sseClients: newClients,
	}
}

// Broadcast metadata to all clients
const broadcastMetadata = (state: StationState) => {
	const message = createMetadataMessage(getCurrentSong(state))
	const encoder = new TextEncoder()
	const data = encoder.encode(`data: ${JSON.stringify(message)}\n\n`)

	state.sseClients.forEach(writer => {
		writer.write(data).catch(() => {
			// Handle failed writes - maybe remove the client
			state = removeSSEClient(state, writer)
		})
	})
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
		broadcastMetadata(state)
	}

	scheduleNextSong(state, handleStateChange, () => {})

	// Return extended interface
	return {
		getCurrentSong: () => getCurrentSong(state),
		getCurrentBuffer: () => getCurrentBuffer(state),
		getCurrentMetadata: () => getCurrentMetadata(state),
		handleNewSSEConnection: (writer: WritableStreamDefaultWriter) => {
			state = addSSEClient(state, writer)
			// Send initial metadata to new client
			const message = createMetadataMessage(getCurrentSong(state))
			const encoder = new TextEncoder()
			writer.write(encoder.encode(`data: ${JSON.stringify(message)}\n\n`))
		},
		handleSSEDisconnection: (writer: WritableStreamDefaultWriter) => {
			state = removeSSEClient(state, writer)
		},
	}
}

// Create the station instance
const station = await initializeStation()

// Modify your server to include SSE endpoint
const server = Bun.serve({
	port: 5634,
	routes: {
		'/stream': () => {
			const buffer = station.getCurrentBuffer()
			if (!buffer) {
				return new Response('Audio not ready', { status: 503 })
			}

			return new Response(buffer, {
				headers: {
					'Content-Type': 'audio/mpeg',
					'Accept-Ranges': 'bytes',
					'Cache-Control': 'no-cache',
					'Access-Control-Allow-Origin': '*',
				},
			})
		},
		'/metadata': () => {
			let writer: WritableStreamDefaultWriter

			const stream = new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder()

					// Store writer for later use
					writer = controller

					// Send initial metadata
					const initialMetadata = createMetadataMessage(getCurrentSong(state))
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialMetadata)}\n\n`))

					// Add to clients
					station.handleNewSSEConnection(writer)
				},
				cancel() {
					station.handleSSEDisconnection(writer)
				},
			})

			return new Response(stream, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
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
									<div id="metadata">
											<p>Title: <span id="title">-</span></p>
											<p>Artist: <span id="artist">-</span></p>
											<p>Album: <span id="album">-</span></p>
											<img id="albumCover" src="" alt="Album Cover" style="max-width: 300px;">
									</div>
									<audio controls autoplay>
											<source src="/stream" type="audio/mpeg">
											Your browser does not support the audio element.
									</audio>
									<script>
											const evtSource = new EventSource('/metadata');
											evtSource.onmessage = function(event) {
													const metadata = JSON.parse(event.data);
													if (metadata.data) {
															document.getElementById('title').textContent = metadata.data.title;
															document.getElementById('artist').textContent = metadata.data.artist;
															document.getElementById('album').textContent = metadata.data.album;
															document.getElementById('albumCover').src = metadata.data.albumCover;
													}
											};
									</script>
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
