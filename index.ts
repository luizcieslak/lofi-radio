import { join } from 'path'
import { readdir } from 'node:fs/promises'

type Song = {
	path: string
	name: string
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
