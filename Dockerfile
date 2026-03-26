FROM oven/bun:latest

RUN apt-get update && \
  apt-get install -y ffmpeg && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./

RUN bun install --production

COPY . .

# Create directories for volumes
RUN mkdir -p /app/songs /app/src/state

VOLUME ["/app/songs"]

# Railway will provide PORT env var, but expose default for local testing
EXPOSE 5634

# Run the Express server (not legacy index.ts)
CMD ["bun", "run", "src/server.ts"]