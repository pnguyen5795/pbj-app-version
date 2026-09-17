import { randomUUID } from "node:crypto";
import type { TwelveLabsScene } from "./twelveLabs.js";
import type { ProposedCutCategory, ProposedHoldSignal, ProposedConflict, ProposedPatternDiff } from "./trainingStore.js";
// Imported directly from the live frontend profile (not a hand-copied
// snapshot) so conflict-checking always compares against what the planner
// is actually using right now, never a stale duplicate that could drift.
import { TROY_OSTERBERG_STYLE } from "../../src/data/styleProfiles/troyOsterberg.js";

// This is genuinely new territory: there is no existing code anywhere in
// this project that automatically diffs a raw video's detected shots
// against its finished edit's detected shots — the actual confirmed Troy
// profile was built by a human reading Twelve Labs output side-by-side and
// writing prose by hand (style-test/results/troy-osterberg-style.md). This
// module is a best-effort, clearly-heuristic mechanical approximation of
// that same reasoning: match raw shots to final shots by content
// similarity, treat unmatched raw shots as "cut" evidence and the biggest
// surviving matched shot as a "hold longest" candidate. Everything it
// produces is a *proposal* for a human to review (see trainingStore.ts) —
// never applied automatically, precisely because this heuristic hasn't
// been validated the way the hand-built profile has.

interface SimpleScene {
  startSec: number;
  endSec: number;
  description: string;
  objects: string[];
  actions: string[];
}

function toSimpleScenes(scenes: TwelveLabsScene[]): SimpleScene[] {
  return scenes.map((s) => ({
    startSec: s.start_sec,
    endSec: s.end_sec,
    description: s.description,
    objects: s.objects ?? [],
    actions: s.actions ?? [],
  }));
}

// Same coarse word-overlap approach already trusted for redundancy
// clustering in patternEditPlanService.ts, duplicated here (server-side,
// different runtime, no shared util between the two today) rather than
// imported, since that file's clustering is tuned for near-duplicate takes
// within one source, not cross-video raw-to-final matching.
function wordSet(scene: SimpleScene): Set<string> {
  return new Set(
    [...scene.objects, ...scene.actions, scene.description]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function significantSharedWords(sets: Set<string>[]): string[] {
  const tally = new Map<string, number>();
  for (const s of sets) for (const w of s) tally.set(w, (tally.get(w) ?? 0) + 1);
  const majority = Math.ceil(sets.length / 2);
  return [...tally.entries()]
    .filter(([, count]) => count >= majority)
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word);
}

interface PacingStats {
  shotCount: number;
  avgShotLenSec: number;
  shortestShotSec: number;
  longestShotSec: number;
}

function pacingStats(scenes: SimpleScene[]): PacingStats | null {
  if (scenes.length === 0) return null;
  const lens = scenes.map((s) => Math.max(0, s.endSec - s.startSec));
  return {
    shotCount: scenes.length,
    avgShotLenSec: lens.reduce((a, b) => a + b, 0) / lens.length,
    shortestShotSec: Math.min(...lens),
    longestShotSec: Math.max(...lens),
  };
}

/** Finished-only submissions can never produce cut/hold proposals — there's
 *  no raw footage to know what was actually cut, so anything beyond
 *  pacing/tone notes would be a guess dressed up as a confirmed pattern.
 *  Structurally enforced by never populating those arrays here, not just
 *  by convention. */
export function analyzeFinishedOnly(finalScenes: TwelveLabsScene[], finalFileName: string): ProposedPatternDiff {
  const scenes = toSimpleScenes(finalScenes);
  const stats = pacingStats(scenes);

  const noteProposals: string[] = [
    stats
      ? `(reference only — no raw footage submitted) ${finalFileName}: ${stats.shotCount} shot${stats.shotCount === 1 ? "" : "s"}, ` +
        `avg ${stats.avgShotLenSec.toFixed(1)}s/shot (shortest ${stats.shortestShotSec.toFixed(1)}s, longest ${stats.longestShotSec.toFixed(1)}s). ` +
        `Tone/pacing reference only — no raw footage means no keep/cut or hold-longest signal could be extracted from this submission.`
      : `(reference only) ${finalFileName}: no distinct shots detected.`,
  ];

  return { cutCategoryProposals: [], holdSignalProposals: [], noteProposals, conflicts: [] };
}

const MATCH_THRESHOLD = 0.15;
const CLUSTER_THRESHOLD = 0.3;

export function analyzeRawPlusFinal(
  rawScenes: TwelveLabsScene[],
  finalScenes: TwelveLabsScene[],
  rawFileName: string,
  finalFileName: string
): ProposedPatternDiff {
  const raw = toSimpleScenes(rawScenes);
  const final = toSimpleScenes(finalScenes);
  const rawSets = raw.map(wordSet);
  const finalSets = final.map(wordSet);

  // Greedy best-match: each raw scene claims its closest not-yet-claimed
  // final scene, if any final scene is similar enough to plausibly be "the
  // same moment, kept." Anything left unmatched on the raw side is
  // candidate "cut" evidence.
  const usedFinal = new Set<number>();
  const matches: { rawIdx: number; finalIdx: number }[] = [];
  const unmatchedRawIdx: number[] = [];

  for (let i = 0; i < raw.length; i++) {
    let best = -1;
    let bestScore = 0;
    for (let j = 0; j < final.length; j++) {
      if (usedFinal.has(j)) continue;
      const score = jaccard(rawSets[i], finalSets[j]);
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (best >= 0 && bestScore >= MATCH_THRESHOLD) {
      matches.push({ rawIdx: i, finalIdx: best });
      usedFinal.add(best);
    } else {
      unmatchedRawIdx.push(i);
    }
  }

  // Cluster unmatched raw scenes against each other — a single unmatched
  // scene is too weak to graduate into a durable "cut this category"
  // rule on its own, but 2+ similar unmatched scenes is real repeated
  // evidence, the same bar patternEditPlanService uses for redundant-take
  // collapsing.
  const clusters: number[][] = [];
  const assigned = new Set<number>();
  for (const i of unmatchedRawIdx) {
    if (assigned.has(i)) continue;
    const cluster = [i];
    assigned.add(i);
    for (const j of unmatchedRawIdx) {
      if (assigned.has(j)) continue;
      if (jaccard(rawSets[i], rawSets[j]) >= CLUSTER_THRESHOLD) {
        cluster.push(j);
        assigned.add(j);
      }
    }
    clusters.push(cluster);
  }

  const existingHoldKeywords = TROY_OSTERBERG_STYLE.holdSignals.flatMap((s) => s.keywords);
  const existingFullCutKeywords = TROY_OSTERBERG_STYLE.cutCategories
    .filter((c) => c.retentionMultiplier === 0)
    .flatMap((c) => c.keywords);

  const cutCategoryProposals: ProposedCutCategory[] = [];
  const conflicts: ProposedConflict[] = [];

  for (const cluster of clusters) {
    if (cluster.length < 2) continue;
    const members = cluster.map((i) => raw[i]);
    const sharedWords = significantSharedWords(cluster.map((i) => rawSets[i])).slice(0, 5);
    if (sharedWords.length === 0) continue;
    const name = sharedWords.slice(0, 3).join(" / ");

    // Fuzzy substring match against existing category keywords — this is
    // an approximation to suggest "this might extend an existing rule
    // rather than being new," not a guarantee; a reviewer confirms either way.
    const matchedExisting = TROY_OSTERBERG_STYLE.cutCategories.find((c) =>
      c.keywords.some((k) => sharedWords.some((w) => k.includes(w) || w.includes(k)))
    );

    const proposal: ProposedCutCategory = {
      id: randomUUID(),
      matchedExistingName: matchedExisting?.name ?? null,
      name,
      keywords: sharedWords,
      retentionMultiplier: 0,
      citation: `${rawFileName} vs ${finalFileName}: ${cluster.length} raw scenes describing "${members[0].description}" had no match anywhere in the final edit.`,
      evidence: members.map((s) => ({ description: s.description, timestampSec: s.startSec })),
    };
    cutCategoryProposals.push(proposal);

    if (sharedWords.some((w) => existingHoldKeywords.some((hk) => hk.includes(w) || w.includes(hk)))) {
      conflicts.push({
        description: `Proposed cut category "${name}" shares language with an existing hold-signal keyword in ${TROY_OSTERBERG_STYLE.displayName}'s profile — footage matching this description is currently treated as a payoff moment to hold on, not something to cut.`,
      });
    }
  }

  // Hold-signal candidate: whichever matched (kept) pair survived at the
  // longest final duration — the mechanical stand-in for "the single
  // moment this edit held longest on."
  const holdSignalProposals: ProposedHoldSignal[] = [];
  if (matches.length > 0) {
    const longestKept = matches.reduce((a, b) => {
      const aLen = final[a.finalIdx].endSec - final[a.finalIdx].startSec;
      const bLen = final[b.finalIdx].endSec - final[b.finalIdx].startSec;
      return bLen > aLen ? b : a;
    });
    const rawScene = raw[longestKept.rawIdx];
    const finalScene = final[longestKept.finalIdx];
    const rawLen = Math.max(0.1, rawScene.endSec - rawScene.startSec);
    const finalLen = finalScene.endSec - finalScene.startSec;
    const retention = finalLen / rawLen;
    const keywords = significantSharedWords([finalSets[longestKept.finalIdx]]).slice(0, 4);

    if (keywords.length > 0) {
      const proposal: ProposedHoldSignal = {
        id: randomUUID(),
        keywords,
        weight: retention > 0.5 ? 2 : 1,
        evidence: [{ description: finalScene.description, timestampSec: finalScene.startSec }],
      };
      holdSignalProposals.push(proposal);

      if (keywords.some((w) => existingFullCutKeywords.some((ck) => ck.includes(w) || w.includes(ck)))) {
        conflicts.push({
          description: `Proposed hold-signal keywords for "${finalScene.description}" overlap with an existing "cut in full" category in ${TROY_OSTERBERG_STYLE.displayName}'s profile — approving both would tell the planner to sometimes cut and sometimes hold-longest on similar-looking footage.`,
        });
      }
    }
  }

  const rawStats = pacingStats(raw);
  const finalStats = pacingStats(final);
  const noteProposals: string[] = [];
  if (rawStats && finalStats) {
    noteProposals.push(
      `${rawFileName} -> ${finalFileName}: ${raw.length} raw shot${raw.length === 1 ? "" : "s"} compressed to ${final.length} kept shot${final.length === 1 ? "" : "s"} ` +
        `(${matches.length} matched/kept, ${unmatchedRawIdx.length} appear cut). Raw avg ${rawStats.avgShotLenSec.toFixed(1)}s/shot, final avg ${finalStats.avgShotLenSec.toFixed(1)}s/shot.`
    );
  }

  return { cutCategoryProposals, holdSignalProposals, noteProposals, conflicts };
}
