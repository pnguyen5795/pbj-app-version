import type { CreatorStyleProfile } from "./types";

// Mirrors server/src/trainingStore.ts's LearnedAdjustments shape — the
// output of the Style Training review flow (server/src/index.ts's
// /api/training/learned-adjustments). Kept as a plain additive layer
// rather than rewriting the hand-authored profile TS files themselves:
// every field here is data (never prose), so merging it in at resolve
// time is safe and reversible, and nothing here ever reaches a real edit
// plan until a human has approved it in the Style Training review queue.
export interface LearnedAdjustmentsForProfile {
  cutCategoryAdditions: { name: string; keywords: string[]; retentionMultiplier: number; citation: string }[];
  holdSignalAdditions: { keywords: string[]; weight: number }[];
  noteAdditions: string[];
}

export type LearnedAdjustments = Record<string, LearnedAdjustmentsForProfile>;

/** Additively overlays approved training adjustments onto a base profile —
 *  never mutates `base`, and a missing/empty `adjustments` returns `base`
 *  completely unchanged (the default, safe path when the training backend
 *  is unreachable or has nothing approved yet for this profile). */
export function applyLearnedAdjustments(
  base: CreatorStyleProfile,
  adjustments: LearnedAdjustmentsForProfile | undefined
): CreatorStyleProfile {
  if (!adjustments) return base;
  if (
    adjustments.cutCategoryAdditions.length === 0 &&
    adjustments.holdSignalAdditions.length === 0 &&
    adjustments.noteAdditions.length === 0
  ) {
    return base;
  }

  const cutCategories = base.cutCategories.map((c) => ({ ...c, keywords: [...c.keywords] }));
  for (const addition of adjustments.cutCategoryAdditions) {
    const existing = cutCategories.find((c) => c.name === addition.name);
    if (existing) {
      existing.keywords = Array.from(new Set([...existing.keywords, ...addition.keywords]));
    } else {
      cutCategories.push({
        name: addition.name,
        keywords: addition.keywords,
        retentionMultiplier: addition.retentionMultiplier,
        citation: addition.citation,
      });
    }
  }

  return {
    ...base,
    cutCategories,
    holdSignals: [...base.holdSignals, ...adjustments.holdSignalAdditions],
    notes: [...base.notes, ...adjustments.noteAdditions],
  };
}
