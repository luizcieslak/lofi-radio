# 🎵 lofi-radio

A synchronized MP3 streaming radio server with frame-accurate playback and real-time metadata updates. Stream your music library to multiple listeners in perfect sync, just like a real radio station.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.2+-black?logo=bun)](https://bun.sh)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://docker.com)

## Features

- 🎶 **Frame-accurate MP3 streaming** - Precise synchronization across all listeners
- 📡 **Real-time metadata** - Live track updates via Server-Sent Events (SSE)
- 💾 **Playlist persistence** - Resumes from last track on restart
- 🐳 **Docker ready** - Deploy anywhere with containers
- 🆙 **Multiple deployment options** - Railway, Docker, VPS, or local

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime (v1.2+)
- MP3 files for your library

### Local Development

```bash
# 1. Clone the repository
git clone https://github.com/your-username/lofi-radio.git
cd lofi-radio

# 2. Install dependencies
bun install

# 3. Add your songs
mkdir songs
cp /path/to/your/music/*.mp3 songs/

# 4. Start the server
bun run dev
```

Visit `http://localhost:5634` to see your radio player!

### Docker Compose (Recommended)

```bash
# 1. Add your songs
mkdir songs
cp /path/to/your/music/*.mp3 songs/

# 2. Start the server
docker-compose up -d

# 3. View logs
docker-compose logs -f
```

Your radio is now streaming at `http://localhost:5634`

## 📦 Deployment Options

Choose the deployment method that works best for you:

### ☁️ Cloud Platforms

- **[Railway](docs/deployment/railway.md)** ⭐ - Easiest cloud deployment (recommended)
  - One-click deploy with persistent volumes
  - Auto-scaling and monitoring included
  - ~$20-30/month for 24/7 streaming

### 🐳 Self-Hosted

- **[Docker & Docker Compose](docs/deployment/docker.md)** - Container-based deployment
  - Local development or VPS hosting
  - Perfect for home servers or cheap VPS (~$6/month)
  - Full control over your deployment

### 📖 Full Documentation

See [CLAUDE.md](CLAUDE.md) for detailed architecture, code structure, and development guide.

## 🎮 Usage

### Web Player

Open your browser to `http://localhost:5634` (or your deployed URL) to access the live playlist view.

### API Endpoints

| Endpoint                   | Description               |
| -------------------------- | ------------------------- |
| `GET /stream`              | Audio stream (MP3)        |
| `GET /now-playing`         | Current track info (JSON) |
| `GET /now-playing/events`  | Real-time metadata (SSE)  |
| `GET /status`              | Server status             |
| `GET /api/tracks`          | Playlist data             |
| `GET /api/playlist/events` | Playlist updates (SSE)    |

## 🔧 Configuration

### Environment Variables

Create a `.env` file (see [.env.example](.env.example)):

```bash
PORT=5634
```

### Adding Songs

Simply add MP3 files to the `songs/` directory and restart the server:

```bash
# Add songs
cp new-track.mp3 songs/

# Restart
docker-compose restart  # Docker
# or
bun run dev            # Local dev
```

## 🏗️ Architecture

**Key Components:**

- **StreamEngine** ([src/streamEngine.ts](src/streamEngine.ts)) - Frame-by-frame MP3 streaming with precise timing
- **Mp3FrameReader** ([src/mp3parser.ts](src/mp3parser.ts)) - Low-level MP3 frame parser
- **PlaylistManager** ([src/playlistManager.ts](src/playlistManager.ts)) - Track queue with persistence
- **Express Server** ([src/server.ts](src/server.ts)) - REST API and SSE endpoints
- **Web Player** ([public/index.html](public/index.html)) - Example UI

**How It Works:**

1. MP3 files are parsed frame-by-frame (not entire file to memory)
2. Each frame is broadcast to all connected clients simultaneously
3. PreciseTimer ensures sub-millisecond accuracy for perfect sync
4. New listeners join mid-stream (like tuning into a radio station)
5. Playlist state persists across restarts

For deep technical details, see [CLAUDE.md](CLAUDE.md).

## 🛠️ Development

### Commands

```bash
# Run dev server with hot reload
bun run dev

# Format code
bun run format

# Lint code
bun run lint

# Run all checks
bun run check
```

### Code Structure

```
lofi-radio/
├── src/
│   ├── server.ts           # Express server & API
│   ├── streamEngine.ts     # Streaming engine
│   ├── mp3parser.ts        # MP3 parser & timer
│   ├── playlistManager.ts  # Playlist logic
│   └── state/              # Persisted state (gitignored)
├── public/
│   └── index.html          # Web player UI
├── songs/                  # Your MP3 library (gitignored)
├── docs/                   # Deployment guides
├── docker-compose.yml      # Docker Compose config
├── Dockerfile              # Container image
└── railway.toml            # Railway configuration
```

## 🤝 Contributing

Contributions are welcome! Here are some feature ideas needed:

- 🏷️ Extract ID3 tags for better metadata or album image management
- 🔐 Authentication system
- 🎚️ Volume normalization
- ⏯️ Resume mid-song (frame-precise)

Please read [CLAUDE.md](CLAUDE.md) before contributing to understand the architecture.

## 🙏 Acknowledgments

Built with:

- [Bun](https://bun.sh) - Fast JavaScript runtime
- [Express](https://expressjs.com) - Web framework
- [MP3 Frame Format](http://www.mp3-tech.org/programmer/frame_header.html) - Technical reference

## 🐛 Troubleshooting

### "No tracks available"

Add MP3 files to the `songs/` directory and restart the server.

### Port already in use

Change the port in your `.env` file or kill the process using port 5634:

```bash
lsof -ti:5634 | xargs kill
```

---

Made with ❤️ from a lo-fi music lover.
