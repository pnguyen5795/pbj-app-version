// A "confirmed style profile" is the machine-readable form of the kind of
// document produced by analyzing a creator's real raw-footage/finished-edit
// pairs (see e.g. the Troy Osterberg style-test project) — the patterns a
// real human editor of that creator's work has been observed to follow.
// PatternEditPlanService (../../services/live/patternEditPlanService.ts)
// consumes one of these to turn raw scene data into a Play + shot list.

import type { TransitionType } from "../../types";

/** A category of footage this creator is confirmed to cut aggressively (or
 *  entirely), matched against a scene's own detected objects/actions/
 *  description text. */
export interface CutCategory {
  name: string;
  /** Lowercase substrings checked against `description` + `objects` +
   *  `actions` joined together. Any match puts the scene in this category. */
  keywords: string[];
  /** Fraction of the scene's natural duration kept when this category
   *  survives at all. 0 means "cut in full", never trimmed-and-kept. */
  retentionMultiplier: number;
  /** The confirmed-pattern citation shown in editorialNotes when a scene
   *  is cut/trimmed under this category. */
  citation: string;
}

/** Keywords that boost a scene's odds of being the single "hold longest"
 *  moment — matched the same way as CutCategory keywords. */
export interface HoldSignal {
  keywords: string[];
  weight: number;
}

export interface CreatorStyleProfile {
  id: string;
  displayName: string;
  /** Lowercase names/aliases matched against the resolved style name and
   *  the raw prompt to decide this profile applies. */
  matchNames: string[];
  /** Whether this is a profile actually confirmed from real paired
   *  raw/edit examples, vs. the generic fallback. Shown in editorialNotes
   *  so the output is honest about how much evidence backs it. */
  confirmed: boolean;
  cutCategories: CutCategory[];
  holdSignals: HoldSignal[];
  /** Default transition applied to every kept clip's entrance — every
   *  confirmed example so far shows hard cuts only, no stylized
   *  transitions, so this defaults to "cut". */
  transitionDefault: TransitionType;
  /** Fraction of raw duration a "day-in-the-life" edit of this creator's
   *  tends to keep overall — used only as a documentation/notes reference,
   *  never as the hard driver of trimming (targetDurationSec always is). */
  referenceRetentionRate: number;
  /** Smallest length (seconds) a kept, non-hold clip is trimmed down to
   *  before it's considered "as tight as it can go". */
  minKeptClipSec: number;
  /** Smallest length (seconds) a *detected scene* is allowed to survive as
   *  its own clip at all — shorter than this reads as a flash-cut glitch,
   *  not an intentional edit. Enforced structurally (merge/extend/exclude
   *  the offending scene) before any candidate ever reaches allocation;
   *  see enforceMinimumSceneDuration in patternEditPlanService.ts. Distinct
   *  from minKeptClipSec, which governs how tight an already-valid clip
   *  can be trimmed, not whether the scene qualifies to exist at all. */
  minSceneSec: number;
  /** True only for a creator whose confirmed profile explicitly documents
   *  intentional rapid-fire flash cuts as part of their style. Every
   *  profile here (including the generic fallback) is false — this is the
   *  single structural escape hatch from the minSceneSec floor, and it
   *  must come from real confirmed evidence, never assumed. */
  allowsFlashCuts: boolean;
  /** Governs how an uncategorized "gag"/personality clip (not a cut
   *  category, not the hold pick) gets trimmed — to a window anchored on
   *  its own likely payoff moment, not left to fill available budget up to
   *  its full native length (the "hairdryer bit kept at 15s, not 122s"
   *  pattern, scaled down for shorter native clips). */
  punchline: {
    /** Seconds kept before the detected payoff anchor. */
    leadInSec: number;
    /** Seconds kept after the detected payoff anchor. */
    tailSec: number;
    /** Cap used when no hold-signal keyword matches at all — there's no
     *  detected payoff to anchor around, so this is a flat "keep a quick
     *  beat, not the whole clip" default instead of the full native length. */
    defaultCapSec: number;
  };
  /** Human-readable citations of the confirmed patterns this profile
   *  encodes, surfaced in editorialNotes as the "why" behind the overall
   *  approach (arc shape, redundant-take handling, dialogue trimming). */
  notes: string[];
}
