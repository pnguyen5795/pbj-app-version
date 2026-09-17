// Fallback used when the prompt doesn't name a creator with a confirmed
// style profile. Applies the same mechanical steps (redundant-take
// collapsing, target-duration back-planning, hold-longest selection) but
// with neutral keyword lists and an honest `confirmed: false` — the
// planner should never present generic heuristics as if they were a real
// creator's confirmed editing pattern.

import type { CreatorStyleProfile } from "./types";

export const GENERIC_STYLE: CreatorStyleProfile = {
  id: "generic",
  displayName: "generic",
  matchNames: [],
  confirmed: false,

  cutCategories: [
    {
      name: "lead-up / logistics",
      keywords: ["walking to", "boarding", "navigation", "map app", "driving", "putting on"],
      retentionMultiplier: 0.15,
      citation: "No confirmed profile matched this prompt — applying a generic lead-up/logistics discount.",
    },
    {
      name: "in-scene downtime / distraction",
      keywords: ["on their phone", "looking at her phone", "looking at his phone", "video call", "watching a video"],
      retentionMultiplier: 0.2,
      citation: "No confirmed profile matched this prompt — applying a generic screen-distraction discount.",
    },
  ],

  holdSignals: [
    { keywords: ["landmark", "arrival", "awe"], weight: 2 },
    { keywords: ["laugh", "celebrat", "surpris", "funny"], weight: 2 },
  ],

  transitionDefault: "cut",
  referenceRetentionRate: 0.2,
  minKeptClipSec: 1.5,
  minSceneSec: 1.0,
  allowsFlashCuts: false,
  punchline: { leadInSec: 1.5, tailSec: 2.5, defaultCapSec: 4 },

  notes: [
    "No creator-specific confirmed style profile matched this prompt — this plan applies only generic redundant-take collapsing and target-duration math, not a verified editing signature.",
  ],
};
