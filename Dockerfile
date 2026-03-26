FROM oven/bun:latest

RUN apt-get update && \
  apt-get install -y ffmpeg && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./

RUN bun install --production

COPY . .

# Create directories for volumes (Railway will mount here)
RUN mkdir -p /app/songs /app/src/state

# NOTE: Railway volumes are configured in the dashboard, not Dockerfile
# The VOLUME keyword is banned by Railway - use Railway dashboard instead

# Railway will provide PORT env var, but expose default for local testing
EXPOSE 5634

# Run the Express server (not legacy index.ts)
CMD ["bun", "run", "src/server.ts"]