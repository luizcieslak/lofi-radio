# Recording Promo Videos

Workflow for producing the ~1 minute vertical clips posted to Instagram / TikTok /
YouTube Shorts: pick the part of a song worth featuring, style the page to match it,
record the player, and cut the audio.

The video is visually static — the [cieslak.dev](https://cieslak.dev) radio page with
its cover art and title — so the whole job is choosing **which 60 seconds** of a track
to use and **which look** suits it.

> ⚠️ **This workflow runs on the `campaign/dj-controls` branch, locally only.**
> The DJ controls drive the **single global broadcast**: selecting a track or seeking
> changes what every connected listener hears. Never run this branch against a server
> real listeners are on. See [the branch caveats](#branch-caveats) before shipping
> anything.

---

## Prerequisites

| Thing | Why |
| --- | --- |
| `lofi-radio` on `campaign/dj-controls`, running locally | Provides the DJ tab, clip markers, and per-track theme |
| `RADIO_API_KEY` in `.env` | All DJ + metadata routes are admin-gated |
| `cieslak-dev` running locally, pointed at this server | The page you actually film |
| `ffmpeg` | Cutting the audio slice |
| A screen recorder | OBS, or the browser's own capture |

Start both servers:

```bash
# terminal 1 — the radio
cd lofi-radio
bun run dev                    # :5634

# terminal 2 — the site you film
cd cieslak-dev
PUBLIC_RADIO_API_URL=http://localhost:5634 npx astro dev   # :4321
```

Then open <http://localhost:4321/en/radio/> for the page to film, and
<http://localhost:5634/> → 🔐 → **🎛️ DJ** for the controls.

---

## 1. Find the slice

In the DJ tab, click any track to put it on the air, then use the scrub bar, the
±5s/±10s nudges, and the timecode readout to hunt for the part you want.

Mark the in- and out-points two ways:

- **By ear** — **⌖ Mark In** at the start, **⌖ Mark Out** at the end. Both read the
  live playhead.
- **By hand** — type into the two inputs and press **+ Add**. Accepts `m:ss`,
  `m:ss.f`, `h:mm:ss`, or raw milliseconds (a bare number is ms, matching the export
  format, so you can paste values straight back in).

Each clip row has a **▶** button that replays exactly that slice, so you can audition a
mark before committing to it. A clip that ends after the track does gets a **⚠** badge
— ffmpeg would produce a short or empty cut, so fix those before exporting.

Clips are stored per track in `songs/.radio-state/tracks-meta.json`, keyed by
**filename** (not track id, which `rescan()` renumbers), so they survive restarts and
playlist reordering. Multiple clips per track are fine — mark a few candidates and pick
later.

## 2. Choose the look

Each track carries a **video theme**: `light`, `dark`, or unset.

Set it from the **Video theme** row in the DJ tab. The choice is saved on the track and
pushed to every connected player over SSE, so the `cieslak-dev` page restyles
immediately — no reload. Pick whichever suits the cover art; **Auto** clears the field
and leaves the visitor's own theme preference alone.

The theme is stored alongside the clips and exposed on `/api/tracks` and
`/now-playing`, so it is set once per track and then applies every time you record it.

```bash
# or set it from the shell
curl -X PATCH "localhost:5634/admin/tracks/Novel.mp3/metadata" \
  -H "X-API-Key: $RADIO_API_KEY" -H 'Content-Type: application/json' \
  -d '{"theme":"dark"}'
```

> The player applies a track's theme **on change only**, so the site's own theme toggle
> still works — a manual click stands until the next track asks for something
> different.

## 3. Record

1. Put the track on the air at the clip's start: the clip row's **▶**, or
   `POST /admin/dj/play` with `{ filename, startMs }`.
2. Frame the `cieslak-dev` page (`/en/radio/`) in the recorder, vertically for Shorts.
3. Press play in the page and capture for the clip's length.

Record a couple of seconds of handle on each end — trimming is easier than re-recording.

### Audio: capture or cut?

Screen-recorded audio is fine for a first pass, but for anything you'll actually post,
cut the slice from the source MP3 and mux it in. It avoids the burst-buffer latency,
the recorder's resampling, and any decode artifact:

```bash
# exact slice, no re-encode
ffmpeg -ss 78.551 -to 138.551 -i "songs/Novel.mp3" -c copy clip-audio.mp3

# then replace the recording's audio
ffmpeg -i screen-capture.mp4 -i clip-audio.mp3 \
  -map 0:v -map 1:a -c:v copy -shortest clip-final.mp4
```

`-ss`/`-to` take seconds; the exported clip markers are in **milliseconds**, so divide
by 1000.

> **Seek artifact.** MP3's bit reservoir means a frame can depend on ~511 bytes of the
> preceding one, so a seek can leave a ~50ms decode artifact at the very start. Cutting
> the audio from the source file (above) avoids it entirely. If you do use captured
> audio, start recording a beat before the mark.

### Automating the capture with Playwright

Since the page is visually static, the screen capture is a good candidate for
automation — repeatable, headless, and exactly as long as you ask for, which removes
the fiddliest part of doing it by hand (hitting the timing).

**Playwright records video but NOT audio.** Its
[`recordVideo`](https://playwright.dev/docs/videos) option takes only `dir`, `size`, and
`showActions` — there is no audio option, and the output has no audio track. Two
independent reasons, worth keeping straight:

1. The recorder captures frames only.
2. Chromium is launched with `--mute-audio` among Playwright's default args, so the
   browser is silent regardless. (Removable via
   `ignoreDefaultArgs: ['--mute-audio']` — which un-mutes the browser but still gets
   you no audio in the file.)

This is fine, because **the audio should come from the source MP3 anyway** — see the
section above. Captured audio would carry the burst-buffer latency, any seek artifact,
and a second generational loss on already-lossy MP3. So the split is not a workaround:

```
Playwright  → silent video, exact duration, vertical framing
ffmpeg -ss  → frame-exact lossless audio slice from songs/*.mp3
ffmpeg mux  → the clip
```

Sketch:

```js
const context = await browser.newContext({
  viewport: { width: 1080, height: 1920 },       // vertical for Shorts/Reels
  recordVideo: { dir: 'out/', size: { width: 1080, height: 1920 } },
})
```

Set `size` explicitly: video defaults to the viewport scaled into 800x800, or **800x450
if no viewport is set** — landscape, i.e. the wrong shape for vertical video.

> **Do the local MP3s match what the server streams?** Yes — the server streams the
> files in `songs/` frame-by-frame with no transformation at serve time, so a local cut
> is sample-identical to what a listener hears. The real drift risk is that a *local*
> `songs/` differs from *production's*, since uploads are normalized on the way in
> (44.1kHz stereo, -14 LUFS — see [src/audioNormalizer.ts](../src/audioNormalizer.ts)).
> Spot-check before cutting:
>
> ```bash
> ffprobe -v error -show_entries format=duration,bit_rate -of csv=p=0 "songs/Novel.mp3"
> ```
>
> If a track does differ, pull that file from the server rather than re-encoding the
> local copy to match — another re-encode is another generational loss.

## 4. Export the marks

```bash
curl -s localhost:5634/admin/clips -H "X-API-Key: $RADIO_API_KEY"
```

Or **⬇ Export JSON** in the DJ tab. Shape — keyed by filename, timestamps in ms:

```json
{
  "clips": {
    "Novel.mp3": [
      { "id": "a1b2c3", "startMs": 78551, "endMs": 138551, "label": "intro pad" }
    ]
  }
}
```

Keep a copy outside `songs/` if it matters to you: `songs/` is gitignored, so the marks
are not in version control.

---

## Branch caveats

`campaign/dj-controls` makes two changes that **must not reach real listeners**:

1. **`BURST_LIMIT_BYTES` is 8 KB instead of 128 KB**
   ([src/streamEngine.ts](../src/streamEngine.ts)). The burst-on-connect buffer is what
   keeps a new listener from underrunning at the live edge; at 232 kbps, 128 KB is
   ~4.5s of cushion. That cushion is also click-to-audio latency, which makes the scrub
   bar feel disconnected from the audio while auditioning — so this branch drops it to
   ~0.3s. Restore it before shipping.

2. **The DJ routes exist at all** — `POST /admin/dj/play`, `POST /admin/dj/seek`,
   `PUT /admin/tracks/:filename/clips`, `GET /admin/clips`. Admin-gated, but they
   reach into the live broadcast by design.

Clip markers and the per-track theme are harmless on their own: clips are inert
authoring data, and `theme` is just another metadata field. Only the burst change and
the DJ routes are branch-local.

---

## Reference

| Endpoint | Purpose |
| --- | --- |
| `POST /admin/dj/play` | `{ filename, startMs? }` — put a track on the air, optionally at an offset |
| `POST /admin/dj/seek` | `{ positionMs }` — seek within the current track |
| `PUT /admin/tracks/:filename/clips` | `{ clips: Clip[] }` — replace a track's marks |
| `GET /admin/clips` | Every mark, keyed by filename |
| `PATCH /admin/tracks/:filename/metadata` | `{ theme: "light" \| "dark" \| null }` among other fields |
| `GET /now-playing` | Current track (incl. `theme`) + live `positionMs` / `durationMs` |

All admin routes require `X-API-Key`.
