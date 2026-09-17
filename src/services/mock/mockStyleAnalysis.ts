import type { StyleAnalysisService, StyleAnalysisResult, StyleReferenceInput } from "../interfaces";
import { delay } from "../../utils/id";

const PACINGS: StyleAnalysisResult["pacing"][] = [
  "slow",
  "medium",
  "fast",
  "punchy",
];

/**
 * Stand-in for a "referenced style" analyzer — in the real product this
 * would resolve a creator handle / link mentioned in the prompt and
 * inspect their published edits. Here we just infer something plausible
 * from the prompt text so downstream planning has a style to react to.
 */
export class MockStyleAnalysisService implements StyleAnalysisService {
  async analyze(
    prompt: string,
    reference?: StyleReferenceInput
  ): Promise<StyleAnalysisResult> {
    await delay(1000 + Math.random() * 600);

    const lower = prompt.toLowerCase();
    let pacing: StyleAnalysisResult["pacing"] = "medium";
    if (reference?.presetName) {
      pacing = pacingForPreset(reference.presetName);
    } else if (/(fast|hype|energetic|punchy|quick)/.test(lower)) pacing = "punchy";
    else if (/(slow|calm|cinematic|dreamy|chill)/.test(lower)) pacing = "slow";
    else if (/(surf|beach|summer|travel)/.test(lower)) pacing = "fast";
    else pacing = PACINGS[prompt.length % PACINGS.length];

    const styleName =
      reference?.presetName ??
      (reference?.url ? describeReferenceUrl(reference.url) : extractStyleName(prompt));

    return {
      styleName,
      summary: `Modeled the edit after ${styleName}: snappy cuts on the beat, punchy jump cuts, bold minimal captions, and warm, sun-washed color grading.`,
      traits: [
        "jump cuts on beat",
        "bold sans-serif captions",
        "warm color grade",
        "handheld energy",
        "quick zoom punches",
      ],
      pacing,
    };
  }
}

function pacingForPreset(presetName: string): StyleAnalysisResult["pacing"] {
  const lower = presetName.toLowerCase();
  if (lower.includes("vlog")) return "punchy";
  if (lower.includes("cinematic")) return "slow";
  if (lower.includes("retro")) return "medium";
  return "fast";
}

function describeReferenceUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return `the reference video (${host})`;
  } catch {
    return "the reference video you linked";
  }
}

function extractStyleName(prompt: string): string {
  const likeMatch = prompt.match(/like\s+([a-zA-Z0-9_. '@-]{2,30})/i);
  if (likeMatch) {
    return likeMatch[1].trim().replace(/[.,!?]$/, "");
  }
  return "a popular creator aesthetic";
}
