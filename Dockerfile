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
RUN mkdir -p /app/songs /app/data

VOLUME ["/app/songs", "/app/data"]

# # TEST: move already created files to volume
# COPY ./songs /app/songs

EXPOSE 5634

# Run in production mode, enabling local network access
CMD ["bun", "run", "index.ts", "--host"]