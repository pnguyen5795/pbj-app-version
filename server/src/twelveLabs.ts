import fs from "node:fs";

// Adapted directly from style-test/analyze.js's "shots" pass — same prompt,
// same schema, same max_tokens override — since that pass is the one
// that's already been validated all session as the source of real
// keep/cut/hold-longest reasoning material. Only the shots pass is called
// here (no transcript/captions/audio/highlights): the pattern planner only
// consumes shot-level scenes, and skipping the other four passes keeps
// live multi-person testing fast and cheap, same tradeoff made for the
// flight and arcade raw-clip pools earlier this session.

const API_BASE = "https://api.twelvelabs.io/v1.3";

export interface TwelveLabsScene {
  scene_number?: number;
  start_sec: number;
  end_sec: number;
  description: string;
  objects: string[];
  actions: string[];
  pacing_note?: string;
  camera_movement?: string;
  framing?: string;
}

export interface ShotsResult {
  scenes: TwelveLabsScene[];
  pacing_arc: string | null;
  overall_visual_tone: string | null;
  editing_rhythm: string | null;
}

const SHOTS_PROMPT =
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
  "say so directly. Respond using the given JSON schema.";

const SHOTS_SCHEMA = {
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
};

export async function analyzeShots(videoPath: string, apiKey: string, signal?: AbortSignal): Promise<ShotsResult> {
  const base64 = fs.readFileSync(videoPath).toString("base64");

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/analyze`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_name: "pegasus1.5",
        video: { type: "base64_string", base64_string: base64 },
        prompt: SHOTS_PROMPT,
        stream: false,
        response_format: { type: "json_schema", json_schema: SHOTS_SCHEMA },
        max_tokens: 8192,
      }),
      signal,
    });
  } catch (err) {
    // A bare network-level failure (connection reset, DNS, TLS, or an
    // aborted request) throws here with no HTTP status at all — Node's
    // generic "fetch failed" TypeError hides the real reason in `.cause`,
    // which the stress test found gave a completely useless error message
    // to the end user. Surface it.
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Twelve Labs request timed out or was cancelled");
    }
    const cause = err instanceof Error && "cause" in err ? (err.cause as Error | undefined) : undefined;
    throw new Error(`Twelve Labs network error: ${cause?.message ?? (err as Error).message}`);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Twelve Labs /analyze failed: ${res.status} ${res.statusText} — ${errText}`);
  }

  const body = await res.json();
  try {
    return JSON.parse(body.data) as ShotsResult;
  } catch {
    throw new Error(`Twelve Labs returned unparseable JSON: ${body.data}`);
  }
}
