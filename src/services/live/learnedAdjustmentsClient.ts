import type { LearnedAdjustments } from "../../data/styleProfiles/mergeLearned";
import { apiBase } from "./apiBase";

/**
 * Fetches the currently-approved Style Training adjustments so real edit
 * generation can benefit from them (see patternEditPlanService.ts) — this
 * is what makes "compounds over time" true rather than just a Style
 * Training UI that doesn't actually feed back into anything.
 *
 * Deliberately resilient: a short timeout and a plain try/catch (not
 * apiFetch, which throws) mean any failure here — server down, endpoint
 * missing, slow network — falls back to `undefined` (no adjustments,
 * exactly today's pre-training-feature behavior) rather than ever
 * blocking or breaking real edit-plan generation.
 */
export async function fetchLearnedAdjustments(): Promise<LearnedAdjustments | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${apiBase()}/api/training/learned-adjustments`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const body: { adjustments: LearnedAdjustments } = await res.json();
    return body.adjustments;
  } catch {
    return undefined;
  }
}
