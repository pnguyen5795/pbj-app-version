import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_BASE = "https://api.twelvelabs.io/v1.3";
const API_KEY = process.env.TWELVE_LABS_API_KEY;
const MAX_BASE64_BYTES = 30 * 1024 * 1024; // Twelve Labs' documented limit on the base64-encoded field itself
// Raw file size that stays under MAX_BASE64_BYTES once base64-encoded (~4/3 inflation), with a small safety margin.
const MAX_RAW_FILE_BYTES = Math.floor(((MAX_BASE64_BYTES * 3) / 4) * 0.98);

function log(message) {
  console.log(`[analyze] ${message}`);
}

function fail(message) {
  console.error(`[analyze] ERROR: ${message}`);
  process.exit(1);
}

function isUrl(input) {
  return /^https?:\/\//i.test(input);
}

function buildVideoField(videoInput) {
  if (isUrl(videoInput)) {
    log("video will be sent by URL (no upload needed)...");
    return { type: "url", url: videoInput };
  }

  if (!fs.existsSync(videoInput)) {
    fail(`video file not found: ${videoInput}`);
  }

  const { size } = fs.statSync(videoInput);
  if (size > MAX_RAW_FILE_BYTES) {
    const estBase64MB = ((size * 4) / 3 / 1024 / 1024).toFixed(1);
    fail(
      `local file is ${(size / 1024 / 1024).toFixed(1)}MB raw (~${estBase64MB}MB once ` +
        `base64-encoded), which exceeds Twelve Labs' 30MB base64 limit. Host it ` +
        `somewhere and pass a URL instead, or compress it smaller.`
    );
  }

  log("encoding local video file (base64)...");
  const base64 = fs.readFileSync(videoInput).toString("base64");
  return { type: "base64_string", base64_string: base64 };
}

// Every signal type below is its own focused /analyze call (same video, a
// narrower prompt + schema) rather than one shared mega-schema — pegasus1.5
// gives each task better attention this way, and it gives us a clean,
// separately-logged progress line per signal type.
const STEPS = [
  {
    key: "shots",
    maxTokens: 8192, // shot lists on longer videos can run long; this pass came close to the 4096 default before
    startLog: "analyzing shots (objects, actions, scene descriptions)...",
    doneLog: (r) => `shots complete (${r.scenes?.length ?? 0} shots)`,
    prompt:
      "Break this video into its shot/scene boundaries, covering the full " +
      "duration in order. For each shot give: start and end timestamps in " +
      "seconds, a scene description, a list of notable objects visible, a " +
      "list of notable actions or movements happening, a pacing_note " +
      "describing the pace or energy of the shot, the camera_movement " +
      "(e.g. static, handheld, panning, tracking, zooming), and the " +
      "framing (e.g. close-up, medium shot, wide shot, selfie-style/POV, " +
      "third-person). After listing every shot, also give three overall " +
      "assessments for the video as a whole: pacing_arc — the shape of its " +
      "energy across the full length (e.g. 'starts high and stays flat', " +
      "'builds gradually', 'spikes and dips', 'steady throughout'); " +
      "overall_visual_tone — its overall color and visual tone (e.g. " +
      "'warm and bright', 'moody and desaturated', 'high contrast', 'soft " +
      "and pastel'); and editing_rhythm — describe the editor's rhythm as " +
      "an attention-allocation strategy, not just a speed. Do they cut " +
      "quickly through routine or low-interest moments but hold noticeably " +
      "longer on moments that are surprising, funny, or emotionally " +
      "resonant, almost letting the viewer catch up? Name at least one " +
      "specific shot they let breathe longer than you'd expect, and why. " +
      "If the pacing is instead uniform/mechanical with no such contrast, " +
      "say so directly. Respond using the given JSON schema.",
    schema: {
      type: "object",
      properties: {
        scenes: {
          type: "array",
          description: "Shot/scene boundaries covering the full video, in order.",
          items: {
            type: "object",
            properties: {
              scene_number: { type: "integer" },
              start_sec: { type: "number" },
              end_sec: { type: "number" },
              description: { type: "string" },
              objects: { type: "array", items: { type: "string" } },
              actions: { type: "array", items: { type: "string" } },
              pacing_note: { type: "string" },
              camera_movement: { type: "string" },
              framing: { type: "string" },
            },
          },
        },
        pacing_arc: { type: "string" },
        overall_visual_tone: { type: "string" },
        editing_rhythm: { type: "string" },
      },
    },
  },
  {
    key: "transcript",
    maxTokens: 8192, // dense continuous dialogue (e.g. unedited raw footage) can exceed the 4096 default before finishing
    startLog: "transcribing speech...",
    doneLog: (r) => `transcript complete (${r.transcript?.length ?? 0} lines)`,
    prompt:
      "Transcribe all spoken dialogue in this video. For each distinct " +
      "utterance give the start and end timestamp in seconds, the speaker " +
      "if distinguishable (e.g. 'Speaker 1', or a name/label if evident), " +
      "the transcribed text, and the emotional tone/sentiment of that line " +
      "(e.g. happy, excited, neutral, serious, sad, angry, sarcastic). Also " +
      "give one overall_sentiment string summarizing the emotional tone of " +
      "the speech across the whole video, and one authenticity_note: does " +
      "the edit preserve natural conversational messiness — multiple " +
      "people talking, interruptions, filler words, shifting or mixed " +
      "moods across speakers — rather than smoothing it into something " +
      "tidier or more produced-sounding? Give a concrete example if you " +
      "can. If there is no spoken dialogue, return an empty transcript " +
      "array, set overall_sentiment to 'no speech detected', and set " +
      "authenticity_note to 'not applicable, no speech'. Respond using " +
      "the given JSON schema.",
    schema: {
      type: "object",
      properties: {
        transcript: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start_sec: { type: "number" },
              end_sec: { type: "number" },
              speaker: { type: "string" },
              text: { type: "string" },
              sentiment: { type: "string" },
            },
          },
        },
        overall_sentiment: { type: "string" },
        authenticity_note: { type: "string" },
      },
    },
  },
  {
    key: "onScreenText",
    startLog: "detecting on-screen text/captions...",
    doneLog: (r) => `on-screen text complete (${r.on_screen_text?.length ?? 0} items)`,
    prompt:
      "Identify any text, captions, subtitles, title cards, lower-third " +
      "labels, or text overlays that appear visually within the video " +
      "itself (not spoken dialogue). For each, give the start and end " +
      "timestamp in seconds, the exact text, the font_style (e.g. bold " +
      "sans-serif, handwritten, blocky meme-style caption), the " +
      "animation type if any (e.g. pop-in, bounce, fade, typewriter, " +
      "static/no animation), and the placement on screen (e.g. centered, " +
      "lower-third, top banner). If none appears, return an empty array. " +
      "Also give one overall caption_philosophy assessment: do these " +
      "text overlays function more like context or personality — labeling " +
      "a place, calling out a product, dropping a joke or a countdown — " +
      "than like a decorative design rhythm? Do they appear on a regular, " +
      "predictable cadence, or only when there's something specific worth " +
      "pointing at? If there is no on-screen text, set caption_philosophy " +
      "to 'not applicable, no on-screen text'. Respond using the given " +
      "JSON schema.",
    schema: {
      type: "object",
      properties: {
        on_screen_text: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start_sec: { type: "number" },
              end_sec: { type: "number" },
              text: { type: "string" },
              font_style: { type: "string" },
              animation: { type: "string" },
              placement: { type: "string" },
            },
          },
        },
        caption_philosophy: { type: "string" },
      },
    },
  },
  {
    key: "audioCues",
    startLog: "detecting audio & music cues...",
    doneLog: (r) => `audio cues complete (${r.audio_cues?.length ?? 0} items)`,
    prompt:
      "Identify notable non-speech audio in this video — background music, " +
      "sound effects, ambient noise, or other audio cues. For each, give " +
      "the start and end timestamp in seconds and a short description " +
      "(e.g. 'upbeat pop music playing', 'engine roar', 'applause and " +
      "cheering'). If none is detectable, return an empty array. Also " +
      "give two overall assessments: music_style — the overall music " +
      "style and energy across the video, and specifically whether the " +
      "cutting pace rises and falls together with the music's energy " +
      "(e.g. 'upbeat pop, high energy throughout, and the cutting pace " +
      "visibly tracks the track's energy', 'no music, ambient only', " +
      "'moody lo-fi, low energy, cuts stay slow and unhurried throughout'); " +
      "and cuts_on_beat — whether cuts feel synced to the music's beat, " +
      "and if so whether that sync feels intentional and musical (like " +
      "they're vibing with the song and riding its mood) versus rigid and " +
      "mechanical (e.g. 'cuts land on the beat during high-energy " +
      "sections, but it feels driven by the song's mood rather than a " +
      "fixed rhythm', 'no clear beat sync', 'not applicable, no music " +
      "present'). Respond using the given JSON schema.",
    schema: {
      type: "object",
      properties: {
        audio_cues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start_sec: { type: "number" },
              end_sec: { type: "number" },
              description: { type: "string" },
            },
          },
        },
        music_style: { type: "string" },
        cuts_on_beat: { type: "string" },
      },
    },
  },
  {
    key: "highlights",
    startLog: "detecting highlights / key moments...",
    doneLog: (r) => `highlights complete (${r.highlights?.length ?? 0} items)`,
    prompt:
      "Identify the standout, most important, or highest-energy key " +
      "moments in this video — the parts someone would want in a " +
      "highlight reel. For each, give the start and end timestamp in " +
      "seconds, a short description, and a reason it stands out. Respond " +
      "using the given JSON schema.",
    schema: {
      type: "object",
      properties: {
        highlights: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start_sec: { type: "number" },
              end_sec: { type: "number" },
              description: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
      },
    },
  },
];

async function runStep(video, step) {
  log(step.startLog);

  const res = await fetch(`${API_BASE}/analyze`, {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_name: "pegasus1.5",
      video,
      prompt: step.prompt,
      stream: false,
      response_format: { type: "json_schema", json_schema: step.schema },
      max_tokens: step.maxTokens ?? 4096,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`POST /analyze (${step.key}) -> ${res.status} ${res.statusText}\n${errText}`);
  }

  const body = await res.json();

  let parsed;
  try {
    parsed = JSON.parse(body.data);
  } catch {
    throw new Error(`could not parse model output as JSON for ${step.key}:\n${body.data}`);
  }

  log(step.doneLog(parsed));
  return { parsed, usage: body.usage };
}

function computePacing(scenes) {
  if (!scenes || scenes.length === 0) {
    return { shot_count: 0, avg_shot_length_sec: null, shortest_shot_sec: null, longest_shot_sec: null };
  }

  const lengths = scenes.map((s) => s.end_sec - s.start_sec);
  const total = lengths.reduce((sum, len) => sum + len, 0);

  return {
    shot_count: scenes.length,
    avg_shot_length_sec: Number((total / scenes.length).toFixed(2)),
    shortest_shot_sec: Number(Math.min(...lengths).toFixed(2)),
    longest_shot_sec: Number(Math.max(...lengths).toFixed(2)),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const shotsOnly = args.includes("--shots-only");
  const videoInput = args.find((a) => a !== "--shots-only");

  if (!videoInput) {
    console.log("Usage: node analyze.js [--shots-only] <path/to/video.mp4 | video URL>");
    process.exit(1);
  }

  if (!API_KEY) {
    fail("TWELVE_LABS_API_KEY is not set. Copy .env.example to .env and fill in your key.");
  }

  try {
    const video = buildVideoField(videoInput);
    const steps = shotsOnly ? STEPS.filter((s) => s.key === "shots") : STEPS;

    log("sending video to Twelve Labs for analysis (pegasus1.5)...");
    log(
      shotsOnly
        ? "running shots-only pass (content identification, no transcript/captions/audio/highlights)..."
        : "running 5 focused passes — this can take a few minutes total for longer videos"
    );

    const outputs = {};
    const usageByStep = {};

    for (const step of steps) {
      const { parsed, usage } = await runStep(video, step);
      outputs[step.key] = parsed;
      usageByStep[step.key] = usage;
    }

    const scenes = outputs.shots.scenes ?? [];
    const pacing = computePacing(scenes);

    const result = shotsOnly
      ? {
          source: videoInput,
          model: "pegasus1.5",
          generated_at: new Date().toISOString(),
          shots_only: true,
          pacing,
          pacing_arc: outputs.shots.pacing_arc ?? null,
          overall_visual_tone: outputs.shots.overall_visual_tone ?? null,
          editing_rhythm: outputs.shots.editing_rhythm ?? null,
          scenes,
          usage: usageByStep,
        }
      : {
          source: videoInput,
          model: "pegasus1.5",
          generated_at: new Date().toISOString(),
          pacing,
          pacing_arc: outputs.shots.pacing_arc ?? null,
          overall_visual_tone: outputs.shots.overall_visual_tone ?? null,
          editing_rhythm: outputs.shots.editing_rhythm ?? null,
          scenes,
          transcript: outputs.transcript.transcript ?? [],
          overall_sentiment: outputs.transcript.overall_sentiment ?? null,
          authenticity_note: outputs.transcript.authenticity_note ?? null,
          on_screen_text: outputs.onScreenText.on_screen_text ?? [],
          caption_philosophy: outputs.onScreenText.caption_philosophy ?? null,
          audio_cues: outputs.audioCues.audio_cues ?? [],
          music_style: outputs.audioCues.music_style ?? null,
          cuts_on_beat: outputs.audioCues.cuts_on_beat ?? null,
          highlights: outputs.highlights.highlights ?? [],
          usage: usageByStep,
        };

    const resultsDir = path.join(__dirname, "results");
    fs.mkdirSync(resultsDir, { recursive: true });

    const baseName = isUrl(videoInput)
      ? new URL(videoInput).pathname.split("/").pop() || "video"
      : path.basename(videoInput);
    const outName = `${baseName.replace(/\.[^/.]+$/, "")}.json`;
    const outPath = path.join(resultsDir, outName);

    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    log(`analysis complete, saved to results/${outName}`);
  } catch (err) {
    fail(err.message);
  }
}

main();
