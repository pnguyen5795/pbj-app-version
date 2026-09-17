// Encodes the confirmed patterns from
// `style-test/results/troy-osterberg-style.md` as data, so the pattern
// planner can apply them mechanically instead of re-deriving them from
// scratch each time. Update this file whenever a new paired raw/edit
// example changes or strengthens a confirmed pattern in that brief.

import type { CreatorStyleProfile } from "./types";

export const TROY_OSTERBERG_STYLE: CreatorStyleProfile = {
  id: "troy-osterberg",
  displayName: "Troy Osterberg",
  matchNames: ["troy osterberg", "troy's style", "troy style", "osterberg"],
  confirmed: true,

  cutCategories: [
    {
      name: "lead-up / logistics",
      keywords: [
        "walking to",
        "boarding",
        "tarmac",
        "navigation",
        "map app",
        "steering wheel",
        "driving",
        "brushing teeth",
        "putting on shoes",
        "shoe rack",
        "browsing",
        "souvenir shop",
      ],
      retentionMultiplier: 0,
      citation:
        "Lead-up/logistics footage (boarding, walking-to-location, prep, navigation) is cut in full, not trimmed — confirmed in both paired examples (Rome souvenir browsing/driving; flight boarding/tarmac, a car map-navigation clip).",
    },
    {
      name: "in-scene downtime / distraction",
      keywords: [
        "on their phone",
        "looking at her phone",
        "looking at his phone",
        "video call",
        "watching a video",
        "watching a football game",
        "dice game",
        "playing a game on their smartphone",
      ],
      retentionMultiplier: 0.05,
      citation:
        "Footage of people passively on a screen loses out to footage of people engaged with each other or the experience directly, even when visually similar to what was kept (flight pair: 8 phone/screen clips cut despite looking like the kept cockpit-conversation clips).",
    },
    {
      name: "pure ambient / mood filler",
      keywords: ["photographing", "taking photos of a wall", "brick wall"],
      retentionMultiplier: 0,
      citation:
        "Pure ambient/mood footage with no action or payoff is the first thing cut in full (Rome: a 94s night alley photography scene, the second-longest raw scene, cut entirely).",
    },
  ],

  holdSignals: [
    { keywords: ["landmark", "arrival", "looking up", "awe", "colosseum", "vineyard"], weight: 3 },
    { keywords: ["backflip", "stunt", "jump", "dive", "trick"], weight: 3 },
    { keywords: ["landing", "takeoff", "touchdown"], weight: 2 },
    { keywords: ["laugh", "celebrat", "surpris", "funny", "joke"], weight: 1 },
  ],

  transitionDefault: "cut",
  referenceRetentionRate: 0.19,
  minKeptClipSec: 1.5,
  // No confirmed example ever shows a sub-1s clip — the shortest anything
  // survives at is the ~4-5s range even for a quick gag (the "Daddy" sock
  // beat, the Luigi hat). 1.0s is the floor below which a cut reads as a
  // glitch rather than a deliberate quick beat.
  minSceneSec: 1.0,
  allowsFlashCuts: false,
  // The Rome hairdryer bit (122s raw -> 15s kept, an ~8x compression) is
  // the reference case: a kept-but-uncategorized comedic beat gets held to
  // a short window around its payoff, not stretched to fill the timeline.
  // leadIn+tail sizing is scaled down from that ratio for typically much
  // shorter native gag clips (e.g. the "Daddy" sock clip is only 7.7s
  // native to begin with).
  punchline: { leadInSec: 1.5, tailSec: 2.5, defaultCapSec: 4 },

  notes: [
    "Every confirmed edit follows a calm-open -> single energy/awe peak -> relaxed wind-down arc (LA vlog, Rome edit, flight edit).",
    "Every confirmed edit holds its single longest shot on one non-repeatable payoff/awe moment, not on routine footage (Colosseum ~46% relative retention, the Luigi hat, the plane landing at 7.1s/~30% of that edit's runtime).",
    "Redundant takes of the same beat collapse to a single best representative — a duplicated/flubbed take keeps only the clean pass (Rome's repeated Gladiator line), and a pool of visually-similar clips of the same activity keeps only one (5+ propeller/dashboard shots, 5 duplicate bowling-strike clips in later tests).",
    "Where dialogue survives, it's the clean punchline version — trailing hedges and filler get trimmed off even when the core sentence is kept.",
    "Only a small fraction of the raw clip pool is used at all when working from multiple source clips, not just aggressive in-clip trimming (flight pair: 6 of 27 clips, ~22%, contributed anything).",
    "Cuts are hard cuts throughout every confirmed example — no crossfades, whip-pans, or other stylized transitions observed.",
  ],
};
