/**
 * EXPRESS RADIO STREAMING SERVER
 * ==============================
 *
 * A complete, working radio server using Express.
 * Streams MP3 files to multiple listeners in sync with live metadata updates.
 */

import express, { Request, Response, NextFunction } from "express";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// TYPES
// ============================================================================

interface Mp3FrameHeader {
  frameSize: number;
  bitrate: number;
  sampleRate: number;
  frameDurationMs: number;
}

interface Track {
  id: string;
  path: string;
  title: string;
  artist: string;
  album?: string;
  albumArtUrl?: string;
  durationMs?: number;
}

interface NowPlaying {
  track: Track;
  startedAt: number;
}

// ============================================================================
// MP3 PARSING
// ============================================================================

/**
 * Bitrate lookup table for MPEG1 Layer 3
 * Index comes from 4 bits in the frame header
 */
const BITRATE_TABLE: (number | null)[] = [
  null, // 0000 - reserved
  32, // 0001
  40, // 0010
  48, // 0011
  56, // 0100
  64, // 0101
  80, // 0110
  96, // 0111
  112, // 1000
  128, // 1001
  160, // 1010
  192, // 1011
  224, // 1100
  256, // 1101
  320, // 1110
  null, // 1111 - reserved
];

/**
 * Sample rate lookup table for MPEG1
 */
const SAMPLE_RATE_TABLE: (number | null)[] = [
  44100, // 00
  48000, // 01
  32000, // 10
  null, // 11 - reserved
];

/**
 * Parse an MP3 frame header from 4 bytes
 *
 * Frame header structure:
 * - Byte 0: 0xFF (sync)
 * - Byte 1: 111AABBC (sync continued, version, layer, protection)
 * - Byte 2: DDDDEEEF (bitrate, sample rate, padding)
 * - Byte 3: GGHHJJKK (channel mode, etc.)
 */
function parseFrameHeader(header: Buffer): Mp3FrameHeader | null {
  // Check sync word: first byte must be 0xFF, top 3 bits of second byte must be 1s
  if (header[0] !== 0xff || (header[1] & 0xe0) !== 0xe0) {
    return null;
  }

  // Extract MPEG version (bits 4-3 of byte 1)
  const mpegVersion = (header[1] >> 3) & 0x03;
  if (mpegVersion === 1) return null; // Reserved

  // Extract layer (bits 2-1 of byte 1)
  const layer = (header[1] >> 1) & 0x03;
  if (layer === 0) return null; // Reserved

  // Extract bitrate index (bits 7-4 of byte 2)
  const bitrateIndex = (header[2] >> 4) & 0x0f;
  const bitrate = BITRATE_TABLE[bitrateIndex];
  if (!bitrate) return null;

  // Extract sample rate index (bits 3-2 of byte 2)
  const sampleRateIndex = (header[2] >> 2) & 0x03;
  const sampleRate = SAMPLE_RATE_TABLE[sampleRateIndex];
  if (!sampleRate) return null;

  // Extract padding bit (bit 1 of byte 2)
  const padding = (header[2] >> 1) & 0x01;

  // Calculate frame size for MPEG1 Layer 3
  const frameSize = Math.floor((144 * bitrate * 1000) / sampleRate) + padding;

  // Calculate frame duration (1152 samples per frame for MPEG1 Layer 3)
  const frameDurationMs = (1152 / sampleRate) * 1000;

  return { frameSize, bitrate, sampleRate, frameDurationMs };
}

// ============================================================================
// MP3 FRAME READER
// ============================================================================

class Mp3FrameReader {
  private fd: number;
  private position: number = 0;
  private fileSize: number;

  constructor(filePath: string) {
    this.fd = fs.openSync(filePath, "r");
    this.fileSize = fs.fstatSync(this.fd).size;
    this.skipId3v2Tag();
  }

  /**
   * Skip ID3v2 tag at the beginning of the file if present
   */
  private skipId3v2Tag(): void {
    const header = Buffer.alloc(10);
    fs.readSync(this.fd, header, 0, 10, 0);

    if (header.toString("ascii", 0, 3) === "ID3") {
      // ID3v2 size is a "synchsafe" integer (7 bits per byte)
      const size =
        ((header[6] & 0x7f) << 21) |
        ((header[7] & 0x7f) << 14) |
        ((header[8] & 0x7f) << 7) |
        (header[9] & 0x7f);

      this.position = 10 + size;
      console.log(`[Mp3Reader] Skipped ID3v2 tag: ${this.position} bytes`);
    }
  }

  /**
   * Read the next MP3 frame from the file
   */
  readNextFrame(): { data: Buffer; header: Mp3FrameHeader } | null {
    if (this.position >= this.fileSize) {
      return null;
    }

    // Read potential frame header (4 bytes)
    const headerBuf = Buffer.alloc(4);
    const bytesRead = fs.readSync(this.fd, headerBuf, 0, 4, this.position);

    if (bytesRead < 4) {
      return null;
    }

    // Try to parse as frame header
    const header = parseFrameHeader(headerBuf);

    if (!header) {
      // Not a valid frame header, skip one byte and try again
      // This handles garbage data between frames
      this.position++;
      return this.readNextFrame();
    }

    // Read the full frame (including header)
    const frameData = Buffer.alloc(header.frameSize);
    fs.readSync(this.fd, frameData, 0, header.frameSize, this.position);

    this.position += header.frameSize;

    return { data: frameData, header };
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  reset(): void {
    this.position = 0;
    this.skipId3v2Tag();
  }
}

// ============================================================================
// PRECISE TIMER
// ============================================================================

/**
 * Precise timing using process.hrtime for nanosecond accuracy
 *
 * Standard setTimeout has ~4ms minimum delay and can drift.
 * For audio streaming, we need much better precision.
 */
class PreciseTimer {
  private startTime: bigint = process.hrtime.bigint();
  private elapsedTargetMs: number = 0;

  /**
   * Add time to our "budget" - how much time should have elapsed
   */
  addTime(ms: number): void {
    this.elapsedTargetMs += ms;
  }

  /**
   * Calculate how long we should wait before sending the next frame
   */
  getDelayMs(): number {
    const actualElapsedNs = process.hrtime.bigint() - this.startTime;
    const actualElapsedMs = Number(actualElapsedNs) / 1_000_000;
    return Math.max(0, this.elapsedTargetMs - actualElapsedMs);
  }

  /**
   * Wait until it's time to send the next frame
   */
  async wait(): Promise<void> {
    const delay = this.getDelayMs();

    if (delay > 1) {
      // Use setTimeout for longer waits (saves CPU)
      await new Promise((resolve) => setTimeout(resolve, delay - 1));
    }

    // Busy-wait for final sub-millisecond precision
    while (this.getDelayMs() > 0) {
      // Spin
    }
  }

  reset(): void {
    this.startTime = process.hrtime.bigint();
    this.elapsedTargetMs = 0;
  }
}

// ============================================================================
// STREAM ENGINE
// ============================================================================

class StreamEngine {
  private clients: Set<Response> = new Set();
  private sseClients: Set<Response> = new Set();
  private isRunning: boolean = false;
  private nowPlaying: NowPlaying | null = null;

  /**
   * Add a new audio stream listener
   */
  addClient(res: Response): void {
    // Set headers for streaming audio
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-cache, no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Access-Control-Allow-Origin", "*");
    // Prevent buffering in nginx/proxies
    res.setHeader("X-Accel-Buffering", "no");

    this.clients.add(res);
    console.log(`[Stream] Client connected. Total: ${this.clients.size}`);

    // Remove client when they disconnect
    res.on("close", () => {
      this.clients.delete(res);
      console.log(`[Stream] Client disconnected. Total: ${this.clients.size}`);
    });

    res.on("error", (err) => {
      console.error("[Stream] Client error:", err.message);
      this.clients.delete(res);
    });
  }

  /**
   * Add a Server-Sent Events listener for metadata updates
   */
  addSSEClient(res: Response): void {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");

    this.sseClients.add(res);
    console.log(`[SSE] Client connected. Total: ${this.sseClients.size}`);

    // Send current track immediately
    if (this.nowPlaying) {
      res.write(`data: ${JSON.stringify(this.nowPlaying)}\n\n`);
    }

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(": heartbeat\n\n");
      }
    }, 30000);

    res.on("close", () => {
      clearInterval(heartbeat);
      this.sseClients.delete(res);
      console.log(`[SSE] Client disconnected. Total: ${this.sseClients.size}`);
    });
  }

  /**
   * Broadcast audio data to all connected stream clients
   */
  private broadcast(data: Buffer): void {
    for (const client of this.clients) {
      try {
        if (!client.writableEnded) {
          client.write(data);
        } else {
          this.clients.delete(client);
        }
      } catch (err) {
        console.error("[Stream] Broadcast error:", err);
        this.clients.delete(client);
      }
    }
  }

  /**
   * Broadcast metadata update to all SSE clients
   */
  private broadcastMetadata(): void {
    if (!this.nowPlaying) return;

    const data = JSON.stringify(this.nowPlaying);

    for (const client of this.sseClients) {
      try {
        if (!client.writableEnded) {
          client.write(`data: ${data}\n\n`);
        } else {
          this.sseClients.delete(client);
        }
      } catch (err) {
        console.error("[SSE] Broadcast error:", err);
        this.sseClients.delete(client);
      }
    }
  }

  /**
   * Stream a single track to all listeners
   */
  private async streamTrack(track: Track): Promise<void> {
    console.log(`[Engine] Now playing: ${track.artist} - ${track.title}`);

    // Update now playing and notify SSE clients
    this.nowPlaying = {
      track,
      startedAt: Date.now(),
    };
    this.broadcastMetadata();

    const reader = new Mp3FrameReader(track.path);
    const timer = new PreciseTimer();

    let frameCount = 0;
    let frame = reader.readNextFrame();

    while (frame && this.isRunning) {
      // Send frame to all clients
      this.broadcast(frame.data);

      // Add frame duration to our time budget
      timer.addTime(frame.header.frameDurationMs);

      // Wait until it's time for the next frame
      await timer.wait();

      // Read next frame
      frame = reader.readNextFrame();
      frameCount++;

      // Log progress every ~30 seconds (assuming ~26ms per frame)
      if (frameCount % 1150 === 0) {
        console.log(
          `[Engine] Progress: ${Math.round(frameCount * 26 / 1000)}s, ` +
          `${this.clients.size} listeners`
        );
      }
    }

    reader.close();
    console.log(`[Engine] Finished: ${track.title} (${frameCount} frames)`);
  }

  /**
   * Start the streaming engine with a track provider function
   */
  async start(getNextTrack: () => Promise<Track | undefined>): Promise<void> {
    this.isRunning = true;
    console.log("[Engine] Started");

    while (this.isRunning) {
      const track = await getNextTrack();

      if (!track) {
        console.log("[Engine] No tracks available, waiting 5s...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      // Check if file exists
      if (!fs.existsSync(track.path)) {
        console.error(`[Engine] File not found: ${track.path}`);
        continue;
      }

      try {
        await this.streamTrack(track);
      } catch (err) {
        console.error("[Engine] Error streaming track:", err);
        // Wait a bit before trying next track
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  stop(): void {
    this.isRunning = false;
    console.log("[Engine] Stopped");
  }

  getNowPlaying(): NowPlaying | null {
    return this.nowPlaying;
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      listenerCount: this.clients.size,
      sseClientCount: this.sseClients.size,
      nowPlaying: this.nowPlaying,
    };
  }
}

// ============================================================================
// EXPRESS SERVER
// ============================================================================

const app = express();
const engine = new StreamEngine();

// Middleware
app.use(express.json());

// CORS middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main audio stream endpoint
 * Connect with: <audio src="http://localhost:3000/stream">
 */
app.get("/stream", (req: Request, res: Response) => {
  engine.addClient(res);
  // Note: we don't call res.end() - the response stays open
});

/**
 * Get current track info (JSON)
 */
app.get("/now-playing", (req: Request, res: Response) => {
  const nowPlaying = engine.getNowPlaying();
  res.json(nowPlaying || { track: null });
});

/**
 * Server-Sent Events for live metadata updates
 * Connect with: new EventSource("/now-playing/events")
 */
app.get("/now-playing/events", (req: Request, res: Response) => {
  engine.addSSEClient(res);
});

/**
 * Server status
 */
app.get("/status", (req: Request, res: Response) => {
  res.json(engine.getStatus());
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES (would add auth middleware in production)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Skip current track (placeholder - would need more implementation)
 */
app.post("/admin/skip", (req: Request, res: Response) => {
  // In a real implementation, you'd signal the engine to skip
  res.json({ message: "Skip requested" });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC FILES (Web Player)
// ─────────────────────────────────────────────────────────────────────────────

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, "../public")));

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────

// Demo playlist - replace with your actual tracks
const demoPlaylist: Track[] = [
  {
    id: "1",
    path: "./audio/track1.mp3",
    title: "First Song",
    artist: "Artist One",
    album: "Demo Album",
  },
  {
    id: "2",
    path: "./audio/track2.mp3",
    title: "Second Song",
    artist: "Artist Two",
    album: "Demo Album",
  },
  {
    id: "3",
    path: "./audio/track3.mp3",
    title: "Third Song",
    artist: "Artist Three",
    album: "Another Album",
  },
];

let playlistIndex = 0;

// Start the streaming engine in the background
engine.start(async () => {
  const track = demoPlaylist[playlistIndex];
  playlistIndex = (playlistIndex + 1) % demoPlaylist.length;
  return track;
});

// Graceful shutdown
const shutdown = () => {
  console.log("\nShutting down...");
  engine.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start listening
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    🎵 RADIO SERVER RUNNING                    ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Audio Stream:    http://localhost:${PORT}/stream               ║
║  Now Playing:     http://localhost:${PORT}/now-playing          ║
║  Live Updates:    http://localhost:${PORT}/now-playing/events   ║
║  Status:          http://localhost:${PORT}/status               ║
║                                                               ║
║  Test the stream:                                             ║
║  curl -N http://localhost:${PORT}/stream | mpv -                ║
║                                                               ║
║  Or open in browser:                                          ║
║  http://localhost:${PORT}                                       ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

export { StreamEngine, Mp3FrameReader, PreciseTimer };