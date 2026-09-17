# style-test

Standalone CLI script for experimenting with the Twelve Labs video analysis API.
This is intentionally separate from the main PB&J app's service layer — nothing
here is wired into the app. It's just a sandbox for seeing what Twelve Labs
returns before we design a real integration.

## Setup

```bash
cd style-test
npm install
cp .env.example .env
```

Edit `.env` and paste in your key:

```
TWELVE_LABS_API_KEY=your_real_key
```

## Run

```bash
node analyze.js path/to/video.mp4
```

or with a video URL instead of a local file:

```bash
node analyze.js https://example.com/video.mp4
```

For a lighter, faster pass that only identifies shot/scene content (no
transcript, captions, audio cues, or highlights) — useful when screening a
large pool of raw clips just to see what's in each one — add `--shots-only`:

```bash
node analyze.js --shots-only path/to/clip.mp4
```

## What it does

Twelve Labs' v1.3 API doesn't expose separate transcription/OCR/audio-event
endpoints — everything goes through the `pegasus1.5` multimodal model via
`/analyze`. So this script runs 5 focused passes over the same video, each
with its own narrow prompt + JSON schema (better results than one giant
schema asking for everything at once), and logs each one as it completes:

- **shots** — shot-by-shot boundaries covering the full video (start/end,
  description, detected objects, detected actions, pacing note, camera
  movement, and framing), plus three whole-video assessments: `pacing_arc`
  (the shape of its energy across the full length), `overall_visual_tone`
  (its overall color/visual tone), and `editing_rhythm` (whether the editor
  cuts quickly through low-interest moments but holds longer on surprising
  or resonant ones, with a concrete example)
- **transcript** — spoken dialogue with per-line timestamps, speaker label
  (if distinguishable), and per-line sentiment, plus an `overall_sentiment`
  summary and an `authenticity_note` (whether natural conversational
  messiness — multiple speakers, mixed moods, interruptions — is preserved
  rather than smoothed over)
- **on-screen text** — captions, title cards, or text overlays that appear
  visually in the video (not spoken dialogue), with timestamps, font style,
  animation type, and placement on screen, plus a `caption_philosophy`
  assessment (whether captions function as context/personality vs. a
  decorative rhythm, and whether they appear on a predictable cadence or
  only when there's something worth calling out)
- **audio cues** — background music, sound effects, ambient noise, with
  timestamps and a short description, plus `music_style` (overall style/
  energy, and whether cutting pace tracks the music's energy) and
  `cuts_on_beat` (whether cuts feel beat-synced, and whether that sync
  feels musical/intentional vs. mechanical)
- **highlights** — standout/key moments with a reason each one stands out

It then derives basic pacing stats itself (shot count, average/shortest/
longest shot length) from the shot boundaries, and writes everything to
`results/<video-name>.json`.

Console output shows each pass starting and finishing (with a result count),
so you can watch progress the whole way through. Because this is 5 sequential
API calls instead of 1, expect it to take a few minutes total on longer
videos, and to use more of your Twelve Labs quota per video than before.

## Video input limits

- **URL**: passed straight through to Twelve Labs, no size limit on our end.
- **Local file**: sent inline as base64. Twelve Labs caps the base64-encoded
  field at 30MB, which works out to roughly **22MB raw file size** (base64
  inflates by ~4/3). The script checks this before sending and fails fast
  with a clear message if you're over. For anything larger, host the file
  somewhere and pass a URL instead, or compress it smaller.

## Notes

- No indexing step — `/analyze` works directly on a single video, so nothing
  is created or stored on your Twelve Labs account by running this.
- Requires Node 18+ (uses the built-in `fetch` global).
- `.env` and `results/` are gitignored — your API key and output files stay
  local.
