# CLAUDE.md - lofi-radio Project Documentation

## Project Overview

**lofi-radio** is a synchronized MP3 streaming radio server built with Bun/Node.js and Express. It streams MP3 files frame-by-frame to multiple listeners in perfect sync, with real-time metadata updates via Server-Sent Events (SSE).

### Key Features

- 🎵 **Frame-accurate MP3 streaming** using custom MP3 parser
- 🔄 **Perfect synchronization** across multiple listeners
- 📡 **Real-time metadata updates** via SSE
- 🎨 **Beautiful web player UI** with playlist management
- 🐳 **Docker support** for easy deployment
- 📦 **Dynamic playlist loading** from local MP3 files
- 💾 **Playlist persistence** - Maintains playlist order and resume position across restarts

---

## Architecture

### Core Components

#### 1. **StreamEngine** ([src/streamEngine.ts](src/streamEngine.ts))

The heart of the streaming system. Handles:

- Frame-by-frame MP3 streaming with precise timing
- Multiple concurrent audio stream clients
- SSE clients for metadata updates
- Synchronized playback across all listeners

**Key Methods:**

- `addClient(res)` - Adds audio stream listener
- `addSSEClient(res)` - Adds metadata SSE listener
- `start(getNextTrack)` - Starts streaming loop
- `streamTrack(track)` - Streams a single track with precise timing

#### 2. **Mp3FrameReader** ([src/mp3parser.ts](src/mp3parser.ts))

Low-level MP3 frame parser that:

- Parses MP3 frame headers (sync word, bitrate, sample rate)
- Skips ID3v2 tags
- Extracts individual frames with precise duration calculation
- Supports MPEG1 Layer 3 format

**Frame Duration Calculation:**

```
frameDurationMs = (1152 samples / sampleRate) * 1000
```

#### 3. **PreciseTimer** ([src/mp3parser.ts](src/mp3parser.ts:172))

Nanosecond-accuracy timing system using `process.hrtime.bigint()`:

- Calculates exact delays between frames
- Prevents drift using time budget accumulation
- Combines setTimeout (for longer waits) + busy-wait (sub-millisecond precision)

#### 4. **PlaylistManager** ([src/playlistManager.ts](src/playlistManager.ts))

Manages the track queue with persistence:

- Loads MP3 files from `songs/` directory
- Tracks current playing index
- Notifies SSE clients of track changes
- Provides playlist API
- **Persists playlist state** to `src/state/state.json`
- **Reconciles playlists** on startup (maintains order, handles added/removed songs)

**Key Methods:**

- `loadState()` - Loads persisted state from disk on startup
- `saveState()` - Saves current playlist order and track position to JSON
- `reconcilePlaylist(state)` - Merges saved playlist with current disk contents

#### 5. **MetadataManager** ([src/metadataManager.ts](src/metadataManager.ts))

Manages track metadata with ID3 extraction and manual override support:

- Extracts ID3 tags from uploaded MP3s (title, artist, album, duration)
- Stores metadata in `src/state/tracks-meta.json`
- Supports manual override of extracted metadata
- Priority: manual edit > stored metadata > ID3 tags > filename fallback

**Key Methods:**

- `processUpload(filename, filepath)` - Extract ID3 and store metadata on upload
- `getOrExtract(filename, filepath)` - Get stored or extract from file
- `get(filename)` - Sync access to cached metadata
- `update(filename, updates)` - Manual metadata update
- `delete(filename)` - Remove metadata when track deleted

#### 6. **Express Server** ([src/server.ts](src/server.ts))

REST API and web server with endpoints:

**Public:**
- `GET /stream` - Audio stream endpoint
- `GET /now-playing` - Current track info (JSON)
- `GET /now-playing/events` - SSE metadata updates
- `GET /status` - Server status
- `GET /api/tracks` - Playlist data
- `GET /api/playlist/events` - Playlist SSE updates
- `GET /` - Web player UI

**Admin (requires `X-API-Key` header):**
- `POST /admin/upload` - Upload single MP3
- `POST /admin/upload/batch` - Upload multiple MP3s
- `GET /admin/songs` - List all songs
- `DELETE /admin/songs/:filename` - Delete a song
- `GET /admin/tracks/:filename/metadata` - Get track metadata
- `PATCH /admin/tracks/:filename/metadata` - Update track metadata
- `POST /admin/rescan` - Rescan songs directory

#### 7. **Web Player** ([public/index.html](public/index.html))

Modern, responsive web UI featuring:

- Play/pause controls
- Volume slider
- Live track info with album art
- Real-time playlist with visual indicator
- SSE-driven updates
- Mobile responsive design

**Admin Panel** (click 🔐 button):
- API key authentication (stored in localStorage)
- Upload tab: Drag-and-drop MP3 upload with progress
- Manage tab: Edit/delete tracks, update metadata

---

## File Structure

```
lofi-radio/
├── src/
│   ├── server.ts           # Express server & API routes
│   ├── streamEngine.ts     # Core streaming engine
│   ├── mp3parser.ts        # MP3 frame parser & precise timer
│   ├── playlistManager.ts  # Playlist management with persistence
│   ├── metadataManager.ts  # Track metadata storage & ID3 extraction
│   └── types.ts            # TypeScript interfaces
├── songs/
│   ├── *.mp3               # Music files
│   └── .radio-state/       # Persisted state (inside volume for Railway)
│       ├── state.json      # Playlist order & position
│       └── tracks-meta.json # Track metadata
├── public/
│   └── index.html          # Web player UI
├── songs/                  # MP3 files directory (auto-scanned)
├── scripts/
│   └── generatePlaylist.ts # Utility to generate playlist from files
├── index.ts                # Legacy Bun implementation (see notes)
├── duration.ts             # Song duration utility
├── song-list.ts            # Legacy song list
├── package.json
├── tsconfig.json
├── biome.json             # Code formatter/linter config
├── Dockerfile
└── README.md
```

---

## How It Works

### Streaming Flow

1. **Startup:**

   - `PlaylistManager` scans `songs/` directory for MP3 files
   - Loads persisted state from `src/state/state.json` if it exists
   - Reconciles saved playlist with current disk contents
   - Resumes from last playing track (or starts fresh)
   - `StreamEngine` starts and requests first track from `PlaylistManager`
   - Express server listens on port 5634

2. **Client Connection:**

   - Client connects to `/stream`
   - Server adds client to broadcast set
   - Client receives audio frames in sync with all other clients

3. **Frame-by-Frame Streaming:**

   ```
   For each frame:
     1. Mp3FrameReader reads next frame from file
     2. StreamEngine broadcasts frame to all clients
     3. PreciseTimer calculates exact delay (e.g., ~26ms for typical MP3)
     4. Busy-wait until exact moment to send next frame
     5. Repeat
   ```

4. **Track Changes:**
   - When track ends, `PlaylistManager.getNextTrack()` is called
   - New track starts streaming
   - SSE clients receive metadata update
   - **State is automatically saved** to `state.json`
   - Web UI updates automatically

### Synchronization Strategy

**Problem:** Multiple listeners connecting at different times need to hear the same audio at the same moment.

**Solution:** Frame-by-frame broadcast with precise timing

- All connected clients receive the same frame data simultaneously
- PreciseTimer ensures frames are sent at exact intervals matching the MP3 encoding
- New clients join mid-stream and hear whatever is currently playing

### Playlist Persistence

**Problem:** Server restarts lose playlist order and playback position.

**Solution:** Automatic state persistence with smart reconciliation

**State File Location:** `songs/.radio-state/` (inside songs volume for Railway persistence)

**State Structure:**

```json
{
  "playlistOrder": ["track1.mp3", "track2.mp3", ...],
  "currentTrackFilename": "track2.mp3",
  "currentTrackIndex": 1,
  "lastUpdated": 1771604009107
}
```

**How It Works:**

1. **On Track Change:** State automatically saves to `state.json`
2. **On Startup:** Loads saved state and reconciles with disk
3. **Reconciliation Logic:**
   - Maintains saved playlist order
   - Removes songs no longer on disk
   - Appends new songs to end
   - Resumes from saved track (or starts fresh if missing)

**Edge Cases Handled:**

| Scenario             | Behavior                                  |
| -------------------- | ----------------------------------------- |
| Current song removed | Skips missing file, starts from beginning |
| New songs added      | Appends to end of playlist                |
| Playlist unchanged   | Resumes from exact saved position         |

**Future Enhancement:** Frame-precise resume (currently resumes at track start)

---

## Current Implementation Status

### ✅ Working Features

- Frame-accurate MP3 streaming
- Multi-client synchronization
- Real-time metadata via SSE
- Web player UI with playlist
- Dynamic playlist from `songs/` folder
- **Playlist persistence** - Resumes from last track on restart
- Docker deployment
- Graceful shutdown
- CORS support
- **Radio-style live broadcasts** - listeners join mid-song

### 🎯 Design Philosophy

**True Radio Experience:**
This server intentionally mimics traditional FM/internet radio behavior. When a listener connects, they hear whatever is currently playing—just like tuning into a radio station. This is a **feature, not a bug**.

**Why this matters:**

- ✅ Creates a shared listening experience across all users
- ✅ Everyone hears the same audio at the same moment (perfect sync)
- ✅ Simple, predictable behavior - no buffering, no seeking
- ✅ Authentic "radio station" feel

If you need on-demand playback (start from beginning, pause, rewind), consider building a separate podcast/music player instead. This is designed for live radio streaming.

### 🚧 Limitations & Known Issues

1. **No metadata extraction from MP3 files**

   - Track titles are derived from filenames
   - Artist set to "Unknown Artist"
   - No album art extraction (ID3 tags not parsed)

2. **No authentication on admin routes**

   - Anyone can access `/admin/*` endpoints

3. **Track-level persistence only**

   - Resumes from start of saved track (not mid-song)
   - Frame-precise resume not yet implemented

---

## Code Duplication Note

There are **TWO implementations** in this repository:

### 1. **Express Implementation (Current/Recommended)**

- Files: `src/server.ts`, `src/streamEngine.ts`, etc.
- Runs via: `bun run src/server.ts` or `npm run dev`
- Status: **Fully functional**, production-ready

### 2. **Legacy Bun Implementation**

- File: `index.ts` (root level)
- Uses different streaming strategy (preloads entire song to memory)
- Status: **Legacy**, not maintained
- Notable difference: Loads entire MP3 into `ArrayBuffer` instead of streaming frames

**Recommendation:** Use the Express implementation. Consider removing `index.ts`, `duration.ts`, and `song-list.ts` to avoid confusion.

---

## Next Steps / Improvement Roadmap

- ✅ ~~Extract or sync music metadata (ID3 tags)~~ - Implemented via `music-metadata` library
- ✅ ~~Streamline playlist management~~ - Add, edit, delete tracks via admin API & UI
- ✅ ~~Authentication & Authorization~~ - API key auth for admin routes
- **Frame-precise persistence** - Resume mid-song (currently resumes at track start)
- Enhanced Web UI - Queue management, drag-and-drop reordering
- Volume Normalization - Analyze tracks and normalize loudness
- Statistics & Analytics - Track listen counts, peak listener count, most played tracks, listener duration
- Album art from URL - Currently stores `albumArtUrl` but UI doesn't display it yet

---

## Development Commands

```bash
# Install dependencies
bun install

# Run dev server (hot reload)
bun run dev

# Format code
bun run format

# Lint code
bun run lint

# Run checks (format + lint)
bun run check

# Generate playlist from songs folder
bun run scripts/generatePlaylist.ts
```

---

## Deployment

### Docker

```bash
# Build image
docker build -t lofi-radio .

# Run container
docker run -d \
  -p 5634:5634 \
  -v $(pwd)/songs:/app/songs \
  --name lofi-radio \
  lofi-radio

# View logs
docker logs -f lofi-radio
```

### Environment Variables

- `PORT` - Server port (default: 5634)
- `RADIO_API_KEY` - API key for admin endpoints (required for upload/edit/delete)

---

## API Reference

### Audio Streaming

**`GET /stream`**

- Returns: `audio/mpeg` stream
- Headers: `Transfer-Encoding: chunked`
- Usage: `<audio src="http://localhost:5634/stream">`

### Metadata

**`GET /now-playing`**

- Returns: JSON with current track info
- Example:
  ```json
  {
  	"track": {
  		"id": "1",
  		"title": "Track Name",
  		"artist": "Artist Name",
  		"album": "Album Name",
  		"path": "./songs/track1.mp3"
  	},
  	"startedAt": 1708459200000
  }
  ```

**`GET /now-playing/events`**

- Returns: SSE stream
- Events: Track changes with metadata
- Format: `data: {JSON}\n\n`

### Status

**`GET /status`**

- Returns: Server status
- Example:
  ```json
  {
    "isRunning": true,
    "listenerCount": 5,
    "sseClientCount": 3,
    "nowPlaying": { "track": {...}, "startedAt": 123456 }
  }
  ```

### Playlist

**`GET /api/tracks`**

- Returns: All tracks and current index
- Example:
  ```json
  {
    "tracks": [...],
    "currentIndex": 2
  }
  ```

**`GET /api/playlist/events`**

- Returns: SSE stream for playlist updates
- Events: `playlist`, `trackChange`

---

## Technical Deep Dive

### Why Frame-by-Frame Streaming?

**Alternative 1: File streaming**

```javascript
res.sendFile('song.mp3')
```

❌ Problem: Each client gets their own file read, no synchronization

**Alternative 2: Shared ReadStream**

```javascript
const stream = fs.createReadStream('song.mp3')
stream.pipe(res)
```

❌ Problem: Stream can only be consumed once, late joiners can't connect

**Alternative 3: Frame-by-frame broadcast** ✅

```javascript
for (const frame of mp3Frames) {
	for (const client of clients) {
		client.write(frame)
	}
	await preciseTiming.wait()
}
```

✅ Solution: All clients receive frames simultaneously, perfect sync

### PreciseTimer Accuracy

Standard `setTimeout`:

- Minimum delay: ~4ms (browser/Node.js limitation)
- Drift: Can accumulate over time
- Accuracy: ±4-15ms

PreciseTimer:

- Uses `process.hrtime.bigint()` for nanosecond resolution
- Accumulates time budget to prevent drift
- Busy-waits for final sub-millisecond precision
- Accuracy: ±0.1ms

**Trade-off:** Busy-waiting uses CPU, but ensures audio stays in sync

---

## Troubleshooting

### "No tracks available" message

- Check that `songs/` directory exists
- Ensure `.mp3` files are present
- Check file permissions

### Audio stuttering/buffering

- Check CPU usage (busy-wait may be causing issues)
- Verify network bandwidth
- Check if multiple processes are running

### Clients out of sync

- This shouldn't happen with the current implementation
- If it does, check PreciseTimer accuracy
- Verify frame durations are calculated correctly

### Port already in use

- Change `PORT` environment variable
- Or kill process using port 5634: `lsof -ti:5634 | xargs kill`

---

## Contributing Guidelines

When working on this project:

1. **Test with multiple clients** - Open several browser tabs to verify sync
2. **Check frame timing** - Monitor console logs for frame duration accuracy
3. **Use Biome** - Run `bun run check` before committing
4. **Update this file** - Keep CLAUDE.md in sync with changes
5. **Consider backward compatibility** - Many clients may be connected

---

## Resources & References

- [MP3 Frame Format](http://www.mp3-tech.org/programmer/frame_header.html)
- [Server-Sent Events (SSE)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [Express.js Streaming](https://expressjs.com/en/api.html#res.write)
- [Bun Documentation](https://bun.sh/docs)
