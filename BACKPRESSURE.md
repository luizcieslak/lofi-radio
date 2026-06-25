# BACKPRESSURE.md

Project customization for the backpressured loop. lofi-radio is a synchronized
frame-by-frame MP3 streaming server (Bun + Express). See [CLAUDE.md](CLAUDE.md)
for full architecture.

## Checks

Run before considering any change done:

- **Lint + format:** `bun run check` (Biome `check --write` — autofixes format and lint).
  For a no-write verification use `bun run ci` (`biome ci .`).
- **Typecheck:** `bunx tsc --noEmit` — there is no `typecheck` script in
  `package.json`, but `tsconfig.json` exists with `strict` + `noUncheckedIndexedAccess`.
  Run this explicitly; Biome does not catch type errors.

## Review

Have the reviewer apply these project standards skills to the diff:

- **`code-standards`** — mandatory TS/lint/React/CSS rules (no stray `as`
  assertions, no lint-bypass comments, React Rules of Hooks, mobile-first
  `min-width` breakpoints). Applies to all TypeScript work.
- **`node`** — Node.js + native-TS best practices (async patterns, error
  handling, streams, graceful shutdown). Relevant to the streaming hot path in
  [src/streamEngine.ts](src/streamEngine.ts) and the frame parser.

## Running the app

- **Start (dev, hot reload):** `bun run dev` → serves on port **5634** (override
  with `PORT`). Web player at `http://localhost:5634`.
- **Public endpoints (no auth):** `GET /status`, `GET /now-playing`,
  `GET /now-playing/events` (SSE), `GET /api/tracks`, `GET /api/playlist/events`
  (SSE), `GET /stream` (audio), `GET /` (player UI).
- **Songs:** the server scans `songs/` for `.mp3` files on startup. **There must
  be at least one MP3 in `songs/`** or there's nothing to stream — manual testing
  is meaningless on an empty library. Persisted playlist/position lives in
  `songs/.radio-state/`; clear it if a test needs a fresh start.
- **Credentials:** admin endpoints (`POST /admin/upload`, `DELETE /admin/songs/:filename`,
  `PATCH /admin/tracks/:filename/metadata`, `POST /admin/rescan`) require the
  `X-API-Key` header matching `RADIO_API_KEY`. Set it in a local gitignored
  `.env` (see [.env.example](.env.example)); generate any random value for local
  testing. Public endpoints and the web player need no key.

## Testing

There is **no automated test suite** (no test script, no test runner). The loop's
manual testing (Phase 3) is the real gate:

- Boot `bun run dev`, then curl `/status`, `/now-playing`, and confirm `/stream`
  returns `audio/mpeg` and keeps sending frames.
- Drive the web player via Playwright — play/pause, verify now-playing metadata
  updates over SSE, verify the playlist renders.
- Exercise admin paths with `RADIO_API_KEY` when a change touches upload/edit/delete.
- **Known gap:** this project lacks unit tests. If a change introduces logic that
  genuinely warrants one (e.g. MP3 frame parsing, playlist reconciliation), flag
  that a test should be added rather than silently skipping it.

### Timing-sensitive notes

- The stream engine uses **real-time frame pacing** (`PreciseTimer`, busy-wait +
  `setTimeout`). Some behavior only surfaces over time — let the server run long
  enough to hit a **track boundary** when testing transition/preload changes.
- Known boundary issue (see CLAUDE.md): heterogeneous sample rates (44100 vs
  48000 Hz) cause a hard browser `MediaError` at the track transition. Don't
  mistake that pre-existing gap for a regression unless your change touches it.
- Port 5634 may already be in use — `lsof -ti:5634 | xargs kill` to free it.

## Shipping

- **Open a PR** against `main` on `github.com/luizcieslak/lofi-radio`. Branch
  first, push, open the PR via `gh`.
- There is **no CI** — no GitHub Actions, no required checks. The PR won't have
  status checks to wait on; the local `bun run check` + `bunx tsc --noEmit` +
  manual testing are the gate.
