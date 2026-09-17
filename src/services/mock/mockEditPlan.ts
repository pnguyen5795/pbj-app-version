import type { MediaAsset, EditPlan, TimelineClip, TransitionType } from "../../types";
import type { EditPlanRequest, EditPlanService } from "../interfaces";
import { delay, makeId } from "../../utils/id";

// Neutral gray-scale placeholders — the timeline stays neutral like the
// rest of the layout; the accent color is reserved for the selected-clip
// ring (see Timeline.css), not clip fills.
export const CLIP_COLORS = [
  "linear-gradient(135deg, #aeaeb2, #8e8e93)",
  "linear-gradient(135deg, #c7c7cc, #8e8e93)",
  "linear-gradient(135deg, #8e8e93, #636366)",
  "linear-gradient(135deg, #aeaeb2, #636366)",
  "linear-gradient(135deg, #98989d, #48484a)",
  "linear-gradient(135deg, #c7c7cc, #636366)",
];

const TRANSITIONS_BY_PACING: Record<string, TransitionType[]> = {
  slow: ["crossfade", "cut", "crossfade"],
  medium: ["cut", "crossfade", "cut", "slide"],
  fast: ["cut", "whip-pan", "cut", "zoom"],
  punchy: ["cut", "cut", "whip-pan", "zoom"],
};

/**
 * Stand-in for the vendor that actually assembles a cut list (e.g. an
 * LLM-driven planner on top of Shotstack primitives). Builds a plausible
 * timeline out of the uploaded assets that respects the requested target
 * duration and inferred pacing.
 */
export class MockEditPlanService implements EditPlanService {
  async generate(request: EditPlanRequest): Promise<EditPlan> {
    await delay(1300 + Math.random() * 700);

    const { assets, targetDurationSec, prompt, style } = request;
    const transitions = TRANSITIONS_BY_PACING[style.pacing] ?? TRANSITIONS_BY_PACING.medium;

    const sourceAssets: MediaAsset[] = assets.length > 0 ? assets : [placeholderAsset()];

    // Distribute the target duration across a reasonable clip count,
    // cycling through the uploaded assets if there are fewer assets than
    // the ideal clip count for the chosen pacing/duration.
    const idealClipCount = clampInt(
      Math.round(targetDurationSec / (style.pacing === "punchy" ? 3 : style.pacing === "fast" ? 4 : 6)),
      3,
      10
    );

    const clips: TimelineClip[] = [];
    let cursor = 0;
    for (let i = 0; i < idealClipCount; i++) {
      const asset = sourceAssets[i % sourceAssets.length];
      const remaining = idealClipCount - i;
      const remainingDuration = targetDurationSec - cursor;
      const avg = remainingDuration / remaining;
      const jitter = avg * (0.75 + Math.random() * 0.5);
      const clipLen = i === idealClipCount - 1
        ? Math.max(1, remainingDuration)
        : Math.max(1, Math.min(jitter, remainingDuration - (remaining - 1)));

      const start = cursor;
      const end = Math.round((start + clipLen) * 10) / 10;
      cursor = end;

      clips.push({
        id: makeId("clip"),
        sourceAssetId: asset.id,
        label: asset.fileName.replace(/\.[a-z0-9]+$/i, "") || `Clip ${i + 1}`,
        thumbColor: CLIP_COLORS[i % CLIP_COLORS.length],
        startSec: start,
        endSec: end,
        transitionIn: i === 0 ? "cut" : transitions[i % transitions.length],
        overlays: [],
        sourceInSec: 0,
        sourceOutSec: Math.min(asset.durationSec, clipLen),
        speedMultiplier: i % 4 === 3 ? 1.5 : i % 5 === 2 ? 0.75 : 1,
        muted: i % 3 === 2,
      });
    }

    // Sprinkle in one or two caption overlays so the results screen has
    // something concrete to show, referencing the prompt when possible.
    const overlayText = deriveOverlayText(prompt);
    if (clips.length > 0) {
      clips[0].overlays.push({
        id: makeId("ov"),
        text: overlayText,
        position: "bottom",
        startSec: clips[0].startSec,
        endSec: Math.min(clips[0].endSec, clips[0].startSec + 2.5),
      });
    }
    if (clips.length > 2) {
      const mid = clips[Math.floor(clips.length / 2)];
      mid.overlays.push({
        id: makeId("ov"),
        text: "weekend vibes",
        position: "center",
        startSec: mid.startSec,
        endSec: Math.min(mid.endSec, mid.startSec + 2),
      });
    }

    return {
      id: makeId("plan"),
      targetDurationSec,
      prompt,
      styleSummary: style.summary,
      pacing: style.pacing,
      clips,
      musicSuggestion: pickMusic(style.pacing),
      createdAt: new Date().toISOString(),
    };
  }
}

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function deriveOverlayText(prompt: string): string {
  const words = prompt.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "let's go";
  const snippet = words.slice(0, 3).join(" ");
  return snippet.length > 24 ? snippet.slice(0, 24) : snippet;
}

function pickMusic(pacing: string): string {
  switch (pacing) {
    case "punchy":
      return "Upbeat electro-pop, 128 BPM";
    case "fast":
      return "Indie surf-pop, 118 BPM";
    case "slow":
      return "Lo-fi ambient, 80 BPM";
    default:
      return "Warm acoustic pop, 100 BPM";
  }
}

function placeholderAsset(): MediaAsset {
  return {
    id: makeId("asset"),
    kind: "video",
    fileName: "clip.mp4",
    previewUrl: "",
    durationSec: 6,
    sizeBytes: 0,
  };
}
