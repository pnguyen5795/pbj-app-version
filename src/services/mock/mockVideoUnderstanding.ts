import type { MediaAsset } from "../../types";
import type {
  VideoUnderstandingService,
  VideoUnderstandingResult,
  DetectedScene,
} from "../interfaces";
import { delay } from "../../utils/id";

const TAG_POOL = [
  "outdoor",
  "golden-hour",
  "handheld",
  "close-up",
  "group-shot",
  "motion-blur",
  "beach",
  "candid",
  "low-light",
  "portrait",
  "action",
  "b-roll",
];

function pickTags(seed: number): string[] {
  const count = 2 + (seed % 3);
  const start = seed % TAG_POOL.length;
  const tags: string[] = [];
  for (let i = 0; i < count; i++) {
    tags.push(TAG_POOL[(start + i) % TAG_POOL.length]);
  }
  return Array.from(new Set(tags));
}

// A small bank of plausible shot descriptions, tagged with objects/actions
// that deliberately include some "lead-up/logistics", "screen-distraction",
// and "payoff/awe" flavored entries — so a pattern-driven EditPlanService
// (see services/live/patternEditPlanService.ts) has real keep/cut/hold
// decisions to make against this mocked data, not just one giant
// undifferentiated blob per asset. Twelve Labs (or another real vendor)
// would return this same shape for real.
const SCENE_BANK: { description: string; objects: string[]; actions: string[] }[] = [
  { description: "Walking toward the entrance, talking to camera", objects: ["street", "entrance", "sunglasses"], actions: ["walking", "talking to camera"] },
  { description: "Group boarding and getting settled", objects: ["group", "seats", "bags"], actions: ["boarding", "settling in"] },
  { description: "Checking a map/navigation app before heading out", objects: ["phone", "map app", "steering wheel"], actions: ["navigating", "checking directions"] },
  { description: "Someone looking at their phone, half-watching a video", objects: ["phone", "screen"], actions: ["looking at her phone", "watching a video"] },
  { description: "Arriving at the landmark and looking up in awe", objects: ["landmark", "crowd", "architecture"], actions: ["looking up", "pointing", "smiling"] },
  { description: "A friend pulls off a surprising stunt/trick, everyone reacts", objects: ["friend", "phone recording"], actions: ["stunt", "laughing", "celebrating"] },
  { description: "Group laughing and celebrating a big moment", objects: ["group", "high-five"], actions: ["celebrating", "laughing"] },
  { description: "Steady walking shot between locations", objects: ["street", "storefronts"], actions: ["walking", "talking"] },
  { description: "Close-up detail shot, quick punchline moment", objects: ["hands", "prop"], actions: ["smiling", "joking"] },
  { description: "Casual conversation, direct to camera", objects: ["friend", "background scenery"], actions: ["talking to camera", "gesturing"] },
];

function sceneFor(index: number, seed: number): { description: string; objects: string[]; actions: string[] } {
  return SCENE_BANK[(seed + index * 3) % SCENE_BANK.length];
}

function buildScenes(asset: MediaAsset, seed: number): DetectedScene[] {
  const sceneCount = Math.max(1, Math.min(4, Math.round(asset.durationSec / 8)));
  const scenes: DetectedScene[] = [];
  let cursor = 0;
  for (let i = 0; i < sceneCount; i++) {
    const remaining = sceneCount - i;
    const len = i === sceneCount - 1 ? asset.durationSec - cursor : asset.durationSec / sceneCount;
    const bank = sceneFor(i, seed);
    scenes.push({
      startSec: Math.round(cursor * 10) / 10,
      endSec: Math.round((cursor + len) * 10) / 10,
      description: bank.description,
      objects: bank.objects,
      actions: bank.actions,
    });
    cursor += len;
    void remaining;
  }
  return scenes;
}

/**
 * Stand-in for a video-understanding vendor (e.g. Twelve Labs). Produces
 * a plausible per-asset summary AND a plausible shot-level scene breakdown
 * from the file name / kind / duration, so the rest of the pipeline —
 * including a real pattern-driven edit planner — has something realistic
 * to chain off of.
 */
export class MockVideoUnderstandingService implements VideoUnderstandingService {
  async analyze(assets: MediaAsset[]): Promise<VideoUnderstandingResult> {
    await delay(900 + Math.random() * 500);

    const assetSummaries = assets.map((asset, i) => {
      const seed = asset.fileName.length + i;
      const tags = pickTags(seed);
      const kindWord = asset.kind === "video" ? "clip" : "photo";
      const scenes = asset.kind === "video" ? buildScenes(asset, seed) : undefined;
      return {
        assetId: asset.id,
        summary: `Detected a ${tags[0]} ${kindWord} (~${Math.round(
          asset.durationSec
        )}s) with ${tags.slice(1).join(", ") || "steady framing"}.`,
        tags,
        scenes,
      };
    });

    const videoCount = assets.filter((a) => a.kind === "video").length;
    const photoCount = assets.length - videoCount;

    return {
      assetSummaries,
      overallSummary: `Analyzed ${assets.length} item${
        assets.length === 1 ? "" : "s"
      } (${videoCount} video${videoCount === 1 ? "" : "s"}, ${photoCount} photo${
        photoCount === 1 ? "" : "s"
      }). Found a consistent outdoor, high-energy through-line across the selection.`,
    };
  }
}
