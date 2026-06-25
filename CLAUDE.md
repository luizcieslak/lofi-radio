# CLAUDE.md - lofi-radio Project Documentation

## Project Overview

**lofi-radio** is a synchronized MP3 streaming radio server built with Bun/Node.js and Express. It streams MP3 files frame-by-frame to multiple listeners in perfect sync, with real-time metadata updates via Server-Sent Events (SSE).

### Key Features

- 🎵 **Frame-accurate MP3 streaming** using custom MP3 parser
- 🔄 **Perfect synchronization** across multiple listeners
- ⏭️ **Smoother track transitions** via next-track preload before handoff
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
- Preloading the next track before handoff to reduce audible gaps
- Multiple concurrent audio stream clients
- SSE clients for metadata updates
- Synchronized playback across all listeners
- Reaping dead/stalled connections so zombie sockets don't accumulate

**Key Methods:**

- `addClient(res, sessionId?)` - Adds audio stream listener; `sessionId` (per-tab) dedupes reconnects and powers the unique-listener count. On connect it first replays a **burst-on-connect** backlog (`BURST_LIMIT_BYTES`, ~128 KB of recent frames) so the browser builds an immediate playback cushion instead of underrunning at the live edge
- `addSSEClient(res)` - Adds metadata SSE listener
- `start(peekNextTrack, commitNextTrack)` - Starts streaming loop using peek/commit so the next track is only advanced after the engine actually plays it
- `skipCurrentTrack()` - Signals the current track to stop at the next frame (used when a playing track is deleted)
- `streamTrack(current, peekNextTrack, commitNextTrack)` - Streams a single track; preloads next track ~13s in and commits the handoff at EOF (after re-verifying it still matches `peekNextTrack()`)
- `reapStalledClients()` - Periodic sweep (every 15s, started by `start()`) that `destroy()`s connections that are dead or have been backpressured longer than 45s. Silently-dropped sockets (mobile sleep, NAT timeout, bot scans on the public `/stream`) never emit `close`, so without active reaping they pile up — wasting a `write()` per frame, leaking kernel send buffers + FDs, and inflating the connection count. `broadcast()` skips backpressured clients (tracked via a per-client `stalledSince`) instead of growing an unbounded buffer; TCP keepalive on each socket is the slower OS-level backstop

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
- Tracks current playing index (separate `playingIndex` vs `nextIndex` for peek/commit)
- Notifies SSE clients of track changes and playlist updates
- Provides playlist API
- **Persists playlist state** to `songs/.radio-state/state.json` (inside the songs volume for Railway)
- **Reconciles playlists** on startup (maintains order, handles added/removed songs)
- **Reactive add/remove** without interrupting playback (`addTrack`, `removeTrack`); deleting the playing track triggers an auto-skip
- **Non-blocking persistence** - state saves are serialized through a chained promise so the streaming hot path never awaits disk IO

**Key Methods:**

- `peekNextTrack()` / `commitNextTrack()` - Look at the next track without advancing vs actually advance the cursor (lets the engine preload speculatively)
- `addTrack(filename)` / `removeTrack(filename)` - Reactive playlist mutations
- `setSkipCallback(cb)` - Engine registers its `skipCurrentTrack` here; called when the playing track is deleted
- `notifyTrackChange(track)` - Updates `playingIndex`, broadcasts to SSE clients, persists state
- `rescan()` - Full reload from disk
- `loadState()` / `saveState()` - Persistence (saveState schedules a non-blocking write)
- `reconcilePlaylist(state)` - Merges saved playlist with current disk contents

#### 5. **MetadataManager** ([src/metadataManager.ts](src/metadataManager.ts))

Manages track metadata with ID3 extraction and manual override support:

- Extracts ID3 tags from uploaded MP3s (title, artist, album, durationMs)
- Stores metadata in `songs/.radio-state/tracks-meta.json`
- Supports manual override of extracted metadata
- Priority: manual edit > stored metadata > ID3 tags > filename fallback

**Key Methods:**

- `processUpload(filename, filepath)` - Extract ID3 and store metadata on upload
- `getOrExtract(filename, filepath)` - Get stored or extract from file
- `get(filename)` - Sync access to cached metadata
- `update(filename, updates)` - Manual metadata update
- `delete(filename)` - Remove metadata when track deleted

### Track Metadata Schema

Each track can have the following metadata:

```typescript
interface Track {
  id: string;
  path: string;
  title: string;
  artist: string;
  album?: string;
  albumArtUrl?: string;   // Public URL to album cover image
  durationMs?: number;    // Track duration in milliseconds

  // Platform links (external streaming services)
  spotifyUrl?: string;    // https://open.spotify.com/track/...
  youtubeUrl?: string;    // https://www.youtube.com/watch?v=...
  appleMusicUrl?: string; // https://music.apple.com/...
}
```

`TrackMetadata` (stored in `tracks-meta.json`) carries the same user-visible
fields plus bookkeeping: `extractedFromId3`, `manuallyEdited`, `lastUpdated`.

**Platform Links:**
Tracks can include links to external streaming platforms, enabling features like:
- "Listen on Spotify" buttons in the UI
- YouTube video embeds
- Apple Music integration
- Cross-platform track discovery

**Album Covers:**
Cover artwork is served via CDN URLs for optimal performance. The frontend can display album art using the `albumArtUrl` field.

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
- `POST /admin/upload` - Upload single MP3 (auto-normalized to 44100 Hz / stereo if needed)
- `POST /admin/upload/batch` - Upload multiple MP3s (each auto-normalized; processed sequentially to avoid starving the streaming engine)
- `GET /admin/songs` - List all songs
- `DELETE /admin/songs/:filename` - Delete a song (auto-skips if currently playing)
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
- **Media Session API** - Track info shows on Bluetooth devices, car head units, lock screens
- **Auto-reconnect** - Robust reconnection on stream drops (deploys, network issues)
- **Mobile watchdog** - Detects silent stream death (e.g. background tabs on iOS) and forces a reconnect
- **Per-tab session ID** - Each browser tab gets a sessionStorage-backed ID so the server can count unique listeners and close stale reconnects

**Admin Panel** (click 🔐 button):
- API key authentication (stored in localStorage)
- Upload tab: Drag-and-drop MP3 upload with progress
- Manage tab: Edit/delete tracks, update metadata, platform URLs (Spotify/YouTube/Apple Music)
- Link progress indicator showing completion status per track

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
├── songs/                  # MP3 files directory (auto-scanned)
│   ├── *.mp3
│   └── .radio-state/       # Persisted state (inside volume for Railway)
│       ├── state.json      # Playlist order & position
│       └── tracks-meta.json # Track metadata
├── public/
│   └── index.html          # Web player UI (player + admin panel)
├── scripts/
│   ├── generatePlaylist.ts # Utility to generate playlist from files
│   └── upload-songs.sh     # Bulk-upload helper against /admin/upload/batch
├── docs/                   # Project notes / design docs
├── package.json
├── tsconfig.json
├── biome.json              # Code formatter/linter config
├── Dockerfile
├── docker-compose.yml
├── railway.toml
└── README.md
```

---

## How It Works

### Streaming Flow

1. **Startup:**

   - `PlaylistManager` scans `songs/` directory for MP3 files
   - Loads persisted state from `songs/.radio-state/state.json` if it exists
   - Reconciles saved playlist with current disk contents
   - Resumes from last playing track (or starts fresh)
   - `StreamEngine` starts with `peekNextTrack` / `commitNextTrack` callbacks from `PlaylistManager`
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
   - Around ~13s into the current track, the engine speculatively preloads the next track via `peekNextTrack()` (file open + ID3 skip + first-frame parse off the hot path)
   - At EOF, the engine re-verifies the preload still matches `peekNextTrack()`; if so it calls `commitNextTrack()` and broadcasts the new metadata — all overlapped with the final frame's ~26ms wait so the audible gap is sub-millisecond
   - If the preload is stale (playlist changed mid-track) it's discarded and the next iteration fetches fresh
   - State is persisted via a non-blocking, serialized write to `state.json`
   - Web UI updates automatically via SSE

### Synchronization Strategy

**Problem:** Multiple listeners connecting at different times need to hear the same audio at the same moment.

**Solution:** Frame-by-frame broadcast with precise timing

- All connected clients receive the same frame data simultaneously
- PreciseTimer ensures frames are sent at exact intervals matching the MP3 encoding
- New clients join mid-stream and hear whatever is currently playing
- **Burst-on-connect caveat:** a new client is first sent a ~128 KB backlog of recent frames so its buffer doesn't start empty (which caused audible underrun "chops"). Trade-off: that client starts ~3-4s *behind* the live edge, so sync *between* listeners is now approximate — "perfect sync" is really "perfect sync within the burst window." Acceptable for radio; nobody A/Bs two devices frame-accurately.

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
- **Burst-on-connect buffering** - new listeners get a ~3-4s frame backlog on connect so playback doesn't underrun at the live edge (fixes mid-song "chops")
- Real-time metadata via SSE
- Web player UI with playlist
- Dynamic playlist from `songs/` folder
- **Playlist persistence** - Resumes from last track on restart
- Docker deployment
- Graceful shutdown
- CORS support
- **Radio-style live broadcasts** - listeners join mid-song
- **Media Session API** - Track metadata on Bluetooth/lock screens (via AVRCP)
- **Auto-reconnect** - Handles stream interruptions without manual refresh
- **Platform URL editing** - Admin UI for Spotify/YouTube/Apple Music links
- **Zombie connection reaping** - Backpressure tracking + a 15s reaper sweep + TCP keepalive destroy silently-dropped/stalled `/stream` sockets, so they don't leak buffers/FDs or inflate listener counts. The `Progress` log now reports unique sessions plus raw connections (`N listeners (M raw connections)`)

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

1. **Track transition preload**

   - Preload fires at ~13s in (frame 500). Stale-preload window exists but is bounded by an EOF re-verification against `peekNextTrack()`; mismatches are discarded.
   - Commit work is overlapped with the final frame's wait, so the handoff gap is sub-millisecond in the happy path.
   - Long-run validation with `mpv` or another dumb client is still pending.

2. **Track-level persistence only**

   - Resumes from start of saved track (not mid-song)
   - Frame-precise resume not yet implemented

> **Resolved:** _Heterogeneous library → cross-browser decode error at track boundaries._ Every track is now normalized to a single canonical format — **44100 Hz, stereo, MPEG1 Layer III (libmp3lame VBR V0)** — so the sample rate never changes at a boundary and the single browser decode session no longer throws `MediaError`. New uploads are transcoded on the way in ([src/audioNormalizer.ts](src/audioNormalizer.ts), wired into `POST /admin/upload`); the existing library is brought up to spec by the one-time offline batch normalizer in `~/clawd/lofi-radio-tools` (`normalize-tracks.ts` + `update-normalized-tracks.ts`). Both re-encode **only** files whose sample rate ≠ 44100 Hz, leaving already-canonical files untouched.

---

## Next Steps / Improvement Roadmap

- ✅ ~~Extract or sync music metadata (ID3 tags)~~ - Implemented via `music-metadata` library
- ✅ ~~Streamline playlist management~~ - Add, edit, delete tracks via admin API & UI
- ✅ ~~Authentication & Authorization~~ - API key auth for admin routes
- ✅ ~~Album artwork~~ - Tracks have `coverUrl` pointing to CDN-hosted images
- ✅ ~~Platform links~~ - Spotify, YouTube, Apple Music URLs available per track
- ✅ ~~**Audio format normalization**~~ - **Implemented.** New uploads are transcoded to 44100 Hz / stereo / MPEG1 Layer III (libmp3lame V0) in [src/audioNormalizer.ts](src/audioNormalizer.ts) (wired into `POST /admin/upload` and `/admin/upload/batch`, normalizing only files whose sample rate ≠ 44100, keeping the original on any ffmpeg failure). The existing production library is fixed by the one-time offline batch normalizer + uploader in `~/clawd/lofi-radio-tools`. Loudness normalization was intentionally deferred (it would force re-encoding every file). _Original analysis retained for reference:_ Fix cross-browser decode errors at track boundaries. **Confirmed in BOTH Chrome and Firefox** via in-player logging (earlier notes here wrongly claimed Chrome tolerated this — it does not, it just surfaced less often). Chrome reports `mediaError.code=3 — PIPELINE_ERROR_DECODE: Unsupported midstream configuration change! Sample Rate: 44100 vs 48000, Channels: 2 vs 2`; Firefox reports `NS_ERROR_DOM_MEDIA_DECODE_ERR` / "FFmpeg audio error". **Root cause:** the engine concatenates raw frames from every track into one continuous `audio/mpeg` stream, decoded as a *single* session. The library is heterogeneous (some tracks 44100 Hz, others 48000 Hz), so when the sample rate / channel mode changes at a track boundary the browser's already-initialized decoder throws a **hard, unrecoverable** `MediaError`. Playback can only resume via a fresh decode session, i.e. the player tears down and reopens `/stream` (`error` → reconnect), so the listener hears a brief gap at the offending boundary. Burst-on-connect makes that reconnect recover quickly but does **not** remove the gap. A secondary trigger: [src/mp3parser.ts](src/mp3parser.ts) accepts MPEG2/2.5 and Layer I/II frames but applies MPEG1-Layer-III tables and the `144*bitrate/samplerate` frame-size formula to all of them, so any ≤24 kHz (MPEG2/2.5) or Layer II track is mis-sized → corrupted frame boundaries. **Fix:** normalize the whole library to one canonical output format (e.g. 44100 Hz, stereo, MPEG1 Layer III) — a one-time batch re-encode of the offenders only (leave already-canonical files untouched to avoid needless lossy re-encode) **plus** a transcode-on-upload step in the upload path so new tracks can't reintroduce a mismatch. `ffmpeg` is already in the Docker image and `fluent-ffmpeg` is already a dependency (just not wired up yet). This fixes both triggers and keeps the frame-broadcast design intact. (Diagnostic: `ffprobe -show_entries stream=sample_rate,channels` over `songs/` to enumerate offenders.)
- **Frame-precise persistence** - Resume mid-song (currently resumes at track start)
- Enhanced Web UI - Queue management, drag-and-drop reordering
- Volume Normalization - Analyze tracks and normalize loudness
- Statistics & Analytics - Track listen counts, peak listener count, most played tracks, listener duration
- **UI: Platform link buttons** - Display "Listen on Spotify/YouTube/Apple Music" in player
- **UI: Album art display** - Show cover artwork in now-playing and playlist views

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
      "path": "./songs/track1.mp3",
      "albumArtUrl": "https://cdn.example.com/covers/track-name.jpg",
      "durationMs": 215000,
      "spotifyUrl": "https://open.spotify.com/track/abc123",
      "youtubeUrl": "https://www.youtube.com/watch?v=xyz789",
      "appleMusicUrl": "https://music.apple.com/us/song/track-name/123456"
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

## Media Session API Integration

The player uses the browser's Media Session API to expose track metadata to the operating system, which then forwards it to connected devices via Bluetooth AVRCP.

**How it works:**
```
Web Player → Media Session API → Browser → OS Media Controls → Bluetooth AVRCP → Car/Headphones
```

**Implementation:**
```javascript
if ('mediaSession' in navigator) {
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album || 'Lofi Radio',
    artwork: track.albumArtUrl
      ? [{ src: track.albumArtUrl, sizes: '512x512', type: 'image/jpeg' }]
      : []
  });
  navigator.mediaSession.setActionHandler('play', play);
  navigator.mediaSession.setActionHandler('pause', pause);
}
```

**Supported displays:**
- Car head units (via Bluetooth)
- Phone lock screens
- Bluetooth headphones with display
- OS media controls (macOS Now Playing, Windows SMTC)

---

## Auto-Reconnect System

The player automatically reconnects when the stream is interrupted (server restart, network issues, deploys).

**Detection events:**
- `error` - Stream error
- `stalled` - Buffer stalled for too long
- `pause` - Unexpected pause (stream dropped silently)
- `ended` - Stream ended

**Reconnection strategy:**
- Exponential backoff: 1s → 1.5s → 2.25s → ... (max 30s)
- Shows "Reconnecting (N)..." status
- Resets counter on successful reconnection
- User doesn't need to refresh or interact

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
