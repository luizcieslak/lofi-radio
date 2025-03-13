console.log('Hello via Bun!')

const server = Bun.serve({
	port: 5634,
	fetch(req) {
		return new Response('Bun!')
	},
})

console.log(`Listening on http://localhost:${server.port} ...`)
