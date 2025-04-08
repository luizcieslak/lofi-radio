# lofi-radio

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.5. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Docker setup

# Build

docker build -t lofi-radio .

# Run with volumes

docker run -d \
 -p 5634:5634 \
 -v $(pwd)/songs:/app/songs \
 -v lofi-data:/app/data \
 --name lofi-radio \
 lofi-radio

To see the logs and run it in the foreground, you have two options:

Remove the -d flag to run in foreground:

docker run \
 -p 5634:5634 \
 -v $(pwd)/songs:/app/songs \
 -v lofi-data:/app/data \
 --name lofi-radio \
 lofi-radio

Or if you want to keep it running in detached mode, you can:

# See the logs

docker logs lofi-radio

# Follow the logs (like tail -f)

docker logs -f lofi-radio
To manage the container:

# Stop the container

docker stop lofi-radio

# Start it again

docker start lofi-radio

# Remove the container

docker rm lofi-radio

# List running containers

docker ps

# List all containers (including stopped)

docker ps -a

Try stopping the current container and running it without -d to see the logs in real-time:
docker stop lofi-radio
docker rm lofi-radio
