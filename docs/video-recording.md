# Recording Promo Videos

Workflow for producing the ~1 minute vertical clips posted to Instagram / TikTok /
YouTube Shorts: pick the part of a song worth featuring, choose the look of the page
for it, and render.

The video is visually static — the [cieslak.dev](https://cieslak.dev) radio page with
its cover art and title — so the whole job is choosing **which seconds** of a track
to use and **which theme** suits it. Each such choice is a **scene**: a start, an end,
and a light/dark theme.

> This workflow lives on the `campaign/dj-controls` branch and is meant for local use.
> Nothing in it touches the live broadcast: the editor plays source files in the
> browser, and the recorder pins the page to a track through its URL.

---

## Prerequisites

| Thing | Why |
| --- | --- |
| `lofi-radio` on `campaign/dj-controls`, running | Serves the scene editor, the source MP3s, and stores scenes |
| `RADIO_API_KEY` in `.env` | Scene routes and the audio route are admin-gated |
| `cieslak-dev` on `video-recording`, running | The page that gets filmed (needs pinned-track mode) |
| `ffmpeg` / `ffprobe` | Cutting and muxing the audio |
| Playwright with a full Chromium | Capturing the page (`npx playwright install chromium`) |

```bash
# terminal 1 — the radio
cd lofi-radio
bun run dev                    # :5634

# terminal 2 — the site that gets filmed
cd cieslak-dev
PUBLIC_RADIO_API_URL=http://localhost:5634 npx astro dev   # :4321
```

Then open <http://localhost:5634/editor.html> (or 🔐 → **🎬 Scenes** on the player).

---

## 1. Mark scenes in the editor

Pick a track from the pool on the left. The editor downloads the source MP3 once,
decodes it in the browser, and plays it from memory:

- **Whole-track waveform:** click to seek, drag to select a range. Existing scenes are
  tinted by their theme.
- **Detail strip:** ±5s around the playhead, for landing a mark on a beat. Click to
  seek within it.
- **Transport:** <kbd>Space</kbd> play/pause, <kbd>←</kbd>/<kbd>→</kbd> ±1s
  (<kbd>Shift</kbd> ±5s), <kbd>,</kbd>/<kbd>.</kbd> ±0.1s.
- **Marking:** <kbd>I</kbd> / <kbd>O</kbd> set in/out at the playhead, and
  <kbd>Enter</kbd> adds the range as a scene.

Each scene row has:

- **Start / end fields.** Type `m:ss`, `m:ss.mmm`, `h:mm:ss`, or raw milliseconds (a
  bare number is ms, matching the export). Or use ⤒ / ⤓ to snap either end to the
  playhead.
- **Light / Dark** — the look of the page for this scene.
- **▶ (or <kbd>P</kbd>)** plays the scene exactly as it will render: from start to
  end, with the 2s fade-out inside the end.
- **Recorded**: tick it once the scene's video is done. Done scenes are dimmed, and a
  batch render skips them. Nothing sets it automatically, including the recorder.
- **⚠** when a scene runs past the end of the track. The render would come out short,
  so fix those.

Every edit saves immediately. The right-hand panel shows the actual site page, pinned
to the selected scene's track and theme, at the capture's 1080×1920 scaled down, so the
preview is what gets filmed.

### Why local playback

The first version of this workflow auditioned clips by driving the live broadcast.
Every seek went through the stream engine's real-time frame pacing and then the
browser's stream buffer, so the audio started seconds after the click while the
server-side counter kept running. Marks landed seconds off.

The editor instead decodes the whole file with Web Audio. The playhead comes from the
audio clock, corrected by `getOutputTimestamp()` for output latency (which matters on
Bluetooth). Seeks restart playback from memory, so they're instant.

It decodes rather than using `<audio src>` because the library is VBR. Browsers seek
VBR MP3 through a coarse 100-entry Xing table, so an `<audio>` element's
`currentTime` after a seek can be off by hundreds of ms.

The decoded timeline is **sample-identical to ffmpeg's**, which is what the recorder
cuts with. On `Novel.mp3`, both decode to 9,754,608 samples and put the same peak at
the same sample.

### Pulse

Each scene can make the cover glow react to its music. Select a scene and use the
**Pulse** panel under the stage preview:

- **Strength** (`pulse`, 0–3). 0 is off, which is the default for a new scene unless
  you've tuned one before. New scenes copy the last pulse you set, since one look
  usually carries across a batch.
- **Mode** (`pulseMode`): `bands`, `kick`, `transients`, `colour`, `breathe`, `orbit`
  or `boombap`.
- **Knobs:**
  - Visual strengths: `pulseBass`, `pulseTreble`, `pulseKick`, `pulseSnare` and
    `pulseShimmer` (0–4).
  - Release smoothing: `pulseSmooth` (0.25–4).
  - Drum-detector thresholds: `pulseKickShape` and `pulseSnareStrict` (1–6).
  - Knobs moved off their default are highlighted, and **Reset knobs** puts them all
    back.

Moving a control retunes the preview live, without reloading it, and letting go saves
the scene. Only settings that differ from the site's defaults are stored, and the scene
row shows a `〰 mode · strength` chip.

The pulse follows **the scene's own audio**, not the station. The pinned page decodes
the source MP3 and plays it silently into the glow's analyser. In the editor it starts,
pauses and seeks with the editor's own playback, so the preview pulses to what you
hear. In a render it starts with the capture, so the glow follows the same samples
that are muxed into the file.

The names, ranges and defaults mirror the site's
`src/lib/pulse-params.ts` in cieslak-dev. They are validated here
in [src/scenePulse.ts](../src/scenePulse.ts), which rejects out-of-range values instead
of letting the site clamp them, so a stored scene renders exactly as it previews.

### Themes: scene over track

A scene's look resolves as `scene.theme ?? track.theme`. If neither is set, the page
keeps its own default.

- New scenes are created with an explicit theme (the track's, else light).
- Older scenes without one *inherit* the track's. The editor shows that as an outlined
  toggle, and clicking it pins the value on the scene.
- A track's own `theme` is still editable through the metadata PATCH, and it serves as
  the default for its scenes:

```bash
curl -X PATCH "localhost:5634/admin/tracks/Novel.mp3/metadata" \
  -H "X-API-Key: $RADIO_API_KEY" -H 'Content-Type: application/json' \
  -d '{"theme":"dark"}'
```

Scenes are stored per track in `songs/.radio-state/tracks-meta.json` (as `clips`),
keyed by **filename** rather than track id, since `rescan()` renumbers ids. That keeps
them across restarts and playlist reordering.

## 2. Render

```bash
bun run scripts/recordClips.ts                       # every scene not yet marked Recorded
bun run scripts/recordClips.ts --track "Novel.mp3"   # one track's scenes
bun run scripts/recordClips.ts --clip a1b2c3         # one scene, even if marked Recorded
bun run scripts/recordClips.ts --include-recorded    # re-render Recorded scenes too
bun run scripts/recordClips.ts --dry-run             # plan only (shows theme and pulse)
```

For each scene the script:

1. Opens the site's radio page **pinned** to the scene's track, theme and pulse.
2. Waits for the artwork **and** for `#radio-title` to show that track's title. A
   pulsing scene also waits for the page to decode the scene's audio.
3. For a pulsing scene, starts that audio on the page 2s before the scene's start
   (`PULSE_PREROLL_MS`), so the drum detectors are warmed up and the glow is already
   moving at frame 0.
4. Captures for the scene's length with Chromium's screencast.
5. Cuts the audio from `songs/<file>` with ffmpeg and muxes the two, with a 2s
   fade-out on both streams.

Every scene renders to its own file, so a track with three scenes gives three videos.
Output lands in `recordings/` (gitignored) as `<track-slug>-<clip-id>-1080x1920.mp4`.

Captures run in real time, so a 60s scene takes at least 60s plus setup and encode. A
failed scene is reported and the batch continues. Each multi-scene batch renders every
scene in a fresh child process, because back-to-back captures in one Playwright client
wedge on the third.

### Pinned-track mode (cieslak-dev)

```
/en/radio/?stage&drift=12&driftSpeed=3&track=Novel.mp3&theme=dark&at=60000&pulse=0.5&pulseMode=boombap&pulseKick=0.65
```

- `track=`: `radio-player.ts` fetches `/api/tracks` once and shows that file. It never
  opens `/stream` or the now-playing SSE feed; every reconnect path goes through
  `connect()`, which refuses in pinned mode. What is in frame therefore can't depend
  on the station, and a render never changes what listeners hear. An unknown filename
  renders nothing and logs an error, so the recorder's artwork wait fails loudly
  instead of filming another track.
- **Scene audio:** pinned mode decodes the track from `/api/tracks/:filename/audio` and
  plays it through a zero-gain sink into the glow's analyser. It is decoded rather
  than played through `<audio>` for the same reason as the editor: seeking a VBR MP3
  element is only as precise as its coarse Xing table, so kicks would land off the
  muxed audio. It is driven three ways:
  - **The page's own play button** plays from `at=` (the scene's start, in ms).
  - **The recorder** uses `window.__radioScene.play(atMs)`, after waiting for
    `__radioScene.ready`.
  - **The editor** posts `postMessage` messages to the iframe:
    `radio-scene:play {atMs}`, `radio-scene:pause`, and `radio-scene:pulse {query}`
    (pulse settings as a URL query string, applied live through the same parser the
    URL uses). The page posts `radio-scene:ready` back once the audio is decoded.
    Messages are only accepted from the parent frame.
- `pulse=` and friends: see [Pulse](#pulse). A scene without a pulse gets an explicit
  `pulse=0`, because without the param the site pulses at its default strength as
  soon as audio flows.
- `theme=`: applied before first paint by `BaseLayout`, and it overrides the track's
  own theme. It is written to `localStorage` on the site's origin, so it persists
  there; flip it back with the site's toggle.
- `stage`: hides nav, footer, miniplayer and the play button.
- `drift` / `driftSpeed`: slowly animate the glow.

### Why the audio is cut, not captured

Playwright records no audio (the recorder captures frames only, and Chromium runs with
`--mute-audio`). It doesn't matter, because the audio should come from the source file
anyway: a capture would add resampling and a second generational loss on
already-lossy MP3. The server streams `songs/*.mp3` with no transformation, so a local
cut matches what listeners hear.

The real drift risk is a *local* `songs/` that differs from *production's*, since
uploads are normalized on the way in (44.1 kHz stereo, -14 LUFS — see
[src/audioNormalizer.ts](../src/audioNormalizer.ts)). Spot-check with:

```bash
ffprobe -v error -show_entries format=duration,bit_rate -of csv=p=0 "songs/Novel.mp3"
```

If a track differs, pull the file from the server rather than re-encoding the local
copy.

### Capture details the script handles

- **Frames come from CDP's screencast, not `recordVideo`.** `recordVideo` deadlocks on
  the second capture in a process. The screencast's variable-rate frames are resampled
  onto a fixed 30fps timeline, so the output is exactly the scene's length by
  construction.
- **The Astro dev toolbar is in frame** otherwise. It is injected outside the page root
  where `?stage` can't reach, so the harness hides it with an init script.
- **Video needs a full Chromium.** `chromium_headless_shell` fails only at launch; the
  preflight checks for the right build without launching one.
- **The GPU must be enabled** (`--enable-gpu`). Headless Chromium otherwise renders
  with SwiftShader, which is software. On this machine the blurred 1080×1920 glow then
  ran at ~17 fps without pulse and ~6 fps with it, so the glow stepped visibly and the
  pulse landed late. With the GPU it holds 60 fps.
- **Autoplay without a gesture** (`--autoplay-policy=no-user-gesture-required`), so a
  pulsing scene's page can start its audio when the recorder asks.
- **Sync:** measured from the screencast's capture timestamps against the page's
  audio clock, each frame sits ~12 ms behind the muxed audio, under half a frame.
- **Everything is bounded:** launch, capture (real time plus slack), the encoder exit,
  and every ffmpeg call. A wedged process fails its scene instead of stalling the
  batch.
- **Every render is verified:** duration within 0.5s, and audible audio (a
  `volumedetect` mean above -80 dB).

Known flake: an encode can finish a valid MP4 and never report exit. The timeout is
then treated as inconclusive, and verification decides.

## 3. Export

**⬇ Export** in the editor downloads every scene as JSON, or:

```bash
curl -s localhost:5634/admin/clips -H "X-API-Key: $RADIO_API_KEY"
```

```json
{
  "clips": {
    "Novel.mp3": [
      { "id": "a1b2c3", "startMs": 78551, "endMs": 138551, "theme": "dark", "label": "intro pad" }
    ]
  }
}
```

`songs/` is gitignored, so scenes are not in version control. Keep an export if they
matter.

---

## Reference

| Endpoint | Purpose |
| --- | --- |
| `GET /editor.html` | The scene editor |
| `GET /api/tracks/:filename/audio` | The source MP3, decoded by the editor and by pinned mode. **Public** (the site has no key), which is one more reason this branch must not be deployed |
| `PUT /admin/tracks/:filename/clips` | `{ clips: Clip[] }`: replace a track's scenes wholesale |
| `GET /admin/clips` | Every scene, keyed by filename |
| `PATCH /admin/tracks/:filename/metadata` | `{ theme: "light" \| "dark" \| null }` — the track-level default, among other fields |
| `GET /api/tracks` | Public playlist; what pinned mode and the recorder read titles/themes from |

All `/admin` routes require `X-API-Key`. A `Clip` is `{ id, startMs, endMs, label?,
theme?, pulse?, recorded? }`, validated in [src/clipValidation.ts](../src/clipValidation.ts) and
[src/scenePulse.ts](../src/scenePulse.ts).
