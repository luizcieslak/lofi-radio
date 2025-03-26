import { join } from 'path'
import { readdir } from 'node:fs/promises'
import type { SongListItem } from './songs'
import songList from './songs'

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
	sseClients: Set<(metadata: any) => void>
}

const createInitialState = (): StationState => ({
	songs: [],
	currentSongIndex: 0,
	currentSongStartTime: Date.now(),
	isPlaying: false,
	sseClients: new Set(),
})

// Pure function to load songs
const loadSongs = async (): Promise<Song[]> => {
	const songsDir = join(import.meta.dir, 'songs')
	const loadSongFromList = async (song: SongListItem): Promise<Song | null> => {
		const path = join(songsDir, song.filename)
		const fileBuffer = await Bun.file(path).arrayBuffer()

		return {
			path,
			name: song.filename.replace('.mp3', ''),
			buffer: fileBuffer,
			duration: song.duration,
			metadata: {
				title: song.title,
				artist: song.artist,
				album: song.album,
				albumCover: song.albumCover,
			},
		}
	}

	const songPromises = songList.map(loadSongFromList)
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

	console.log('Scheduling next song', currentSong.name, currentSong.duration)

	setTimeout(() => {
		const newState = nextSong(state)
		console.log('Next song schedule triggered')
		onStateChange(newState)
		onMetadataChange()
		scheduleNextSong(newState, onStateChange, onMetadataChange)
	}, currentSong.duration * 1000) // Convert to milliseconds
}

// Pure function to create metadata message
const createMetadataMessage = (song: Song | null) => ({
	type: 'metadata',
	data: song?.metadata ?? null,
	timestamp: Date.now(),
})

// SSE management functions
const addSSEClient = (state: StationState, handler: (metadata: any) => void): StationState => ({
	...state,
	sseClients: new Set([...state.sseClients, handler]),
})

const removeSSEClient = (state: StationState, handler: (metadata: any) => void): StationState => {
	const newClients = new Set(state.sseClients)
	newClients.delete(handler)
	return {
		...state,
		sseClients: newClients,
	}
}

const broadcastMetadata = (state: StationState) => {
	const message = createMetadataMessage(getCurrentSong(state))
	state.sseClients.forEach(handler => {
		try {
			handler(message)
		} catch (error) {
			// Handle failed broadcasts
			state = removeSSEClient(state, handler)
		}
	})
}

// Usage example (this would be your main station controller)
const initializeStation = async () => {
	let state = createInitialState()

	// Load songs
	const songs = await loadSongs()
	state = { ...state, songs }
	console.log(state.songs.map(song => song.name))

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
		handleNewSSEConnection: (writer: (metadata: any) => void) => {
			state = addSSEClient(state, writer)
		},
		handleSSEDisconnection: (writer: (metadata: any) => void) => {
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
			console.log('stream buffer', buffer?.byteLength)
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
			let closed = false
			const encoder = new TextEncoder()

			const stream = new ReadableStream({
				start(controller) {
					// Send initial metadata
					const initialMetadata = createMetadataMessage(station.getCurrentSong())
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialMetadata)}\n\n`))

					// Create a function to handle metadata updates
					const handleMetadata = (metadata: any) => {
						if (!closed) {
							try {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(metadata)}\n\n`))
							} catch (error) {
								console.error('Failed to send metadata:', error)
							}
						}
					}

					// Store the handler
					station.handleNewSSEConnection(handleMetadata)

					// Cleanup when client disconnects
					return () => {
						closed = true
						station.handleSSEDisconnection(handleMetadata)
					}
				},
				cancel() {
					closed = true
				},
			})

			return new Response(stream, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
					'Access-Control-Allow-Origin': '*',
					// Add these headers to prevent buffering
					'X-Accel-Buffering': 'no',
					'Transfer-Encoding': 'chunked',
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
                <audio id="player" controls autoplay>
                    <source src="/stream" type="audio/mpeg">
                    Your browser does not support the audio element.
                </audio>
                <script>
								function connectSSE() {
                        const evtSource = new EventSource('/metadata');
                        const player = document.getElementById('player');
                        
                        evtSource.onmessage = function(event) {
                            const metadata = JSON.parse(event.data);
                        //     	if (player.paused) {
												// 	console.info('Metadata received while player is paused, ignoring');
												// 	return;
												// }
                        if (metadata.data) {
												console.info('Metadata received');
                                document.getElementById('title').textContent = metadata.data.title;
                                document.getElementById('artist').textContent = metadata.data.artist;
                                document.getElementById('album').textContent = metadata.data.album;
                                document.getElementById('albumCover').src = metadata.data.albumCover;
                                
                                player.src = '/stream?' + new Date().getTime();
                                player.play().catch(console.error);
                            }
                        };

                        evtSource.onerror = function(err) {
                            console.warn('SSE connection error:', err);
                            evtSource.close();
                            // Attempt to reconnect after 1 second
                            setTimeout(connectSSE, 1000);
                        };

                        evtSource.onopen = function() {
                            console.log('SSE connection established');
                        };
                    }

                    // Initial connection
                    connectSSE();
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
