import type { MediaAsset, EditPlan, TimelineClip } from "../../types";
import type { EditPlanRequest, EditPlanService, DetectedScene, VideoUnderstandingResult } from "../interfaces";
import { resolveStyleProfile } from "../../data/styleProfiles";
import type { CreatorStyleProfile } from "../../data/styleProfiles";
import { applyLearnedAdjustments } from "../../data/styleProfiles/mergeLearned";
import { fetchLearnedAdjustments } from "./learnedAdjustmentsClient";
import { makeId } from "../../utils/id";

// Real (non-mock) EditPlanService: implements the "Play + shot list"
// workflow — apply a creator's confirmed style profile to decide what to
// keep, what to cut, and the single moment to hold longest on, then
// translate that straight into exact TimelineClip in/out points (the
// domain model already *is* an FFmpeg-ready shot list: sourceInSec/
// sourceOutSec are the trim points, startSec/endSec are assembly order).
//
// This operates on `understanding.assetSummaries[].scenes` — shot-level
// data (start/end/description/objects/actions) shaped exactly like a real
// video-understanding vendor's shot-detection output. When there's no
// vendor wired in yet, each asset is treated as a single undifferentiated
// scene, which still works but can't detect in-clip redundancy or hold
// candidates below the whole-asset level.

const CLIP_COLORS = [
  "linear-gradient(135deg, #aeaeb2, #8e8e93)",
  "linear-gradient(135deg, #c7c7cc, #8e8e93)",
  "linear-gradient(135deg, #8e8e93, #636366)",
  "linear-gradient(135deg, #aeaeb2, #636366)",
  "linear-gradient(135deg, #98989d, #48484a)",
  "linear-gradient(135deg, #c7c7cc, #636366)",
];

/** How far above/below the target the assembled duration is allowed to
 *  land — the workflow spec calls for a 5-10s buffer; splitting the
 *  difference keeps both the allocator and the edge-case check honest. */
const TARGET_BUFFER_SEC = 8;

interface SceneCandidate {
  asset: MediaAsset;
  scene: DetectedScene;
  nativeLen: number;
  category: CreatorStyleProfile["cutCategories"][number] | null;
  holdScore: number;
  /** Where an uncategorized candidate's punchline-window trim should start
   *  (absolute seconds within the source asset) and how long that window
   *  is. Ignored for categorized candidates and for whichever candidate
   *  ends up as the hold pick — both use the full scene span instead via
   *  their own existing logic. Always well-defined (defaults to the full
   *  scene) so no candidate is ever left without a valid trim point. */
  punchlineAnchorStart: number;
  punchlineWindowLen: number;
}

interface Representative {
  candidate: SceneCandidate;
  clusterSize: number;
}

interface AllocatedClip {
  candidate: SceneCandidate;
  clip: TimelineClip;
}

export class PatternEditPlanService implements EditPlanService {
  async generate(request: EditPlanRequest): Promise<EditPlan> {
    const { assets, targetDurationSec, prompt, understanding, style } = request;
    const baseProfile = resolveStyleProfile(style.styleName, prompt);
    // Style Training's approved-only learned-adjustments layer — see
    // mergeLearned.ts. Never blocks or fails plan generation: an
    // unreachable training backend just means no adjustments apply yet,
    // identical to this feature not existing.
    const learned = await fetchLearnedAdjustments();
    const profile = applyLearnedAdjustments(baseProfile, learned?.[baseProfile.id]);

    const flattened = flattenScenes(assets, understanding, profile);
    const allCandidates = flattened.candidates;
    if (allCandidates.length === 0) {
      throw new Error("No video content to plan an edit from — add at least one video clip.");
    }

    for (const c of allCandidates) {
      c.category = matchCategory(c.scene, profile);
      c.holdScore = holdScoreOf(c.scene, profile);
      const window = computePunchlineWindow(c, profile);
      c.punchlineAnchorStart = window.start;
      c.punchlineWindowLen = window.len;
    }

    const fullyCut = allCandidates.filter((c) => (c.category?.retentionMultiplier ?? 1) === 0);
    const survivors = allCandidates.filter((c) => (c.category?.retentionMultiplier ?? 1) > 0);

    if (survivors.length === 0) {
      const categories = Array.from(new Set(fullyCut.map((c) => c.category!.name)));
      throw new Error(
        `Every detected scene matched a "cut in full" category under ${profile.displayName}'s profile ` +
          `(${categories.join(", ")}). There's nothing left to build an edit from in this footage.`
      );
    }

    const clusters = clusterByRedundancy(survivors);
    const representatives: Representative[] = clusters.map((cluster) => ({
      candidate: cluster.reduce((a, b) => (isBetterCandidate(b, a) ? b : a)),
      clusterSize: cluster.length,
    }));

    const singularPool = representatives.filter((r) => r.clusterSize === 1);
    const holdPool = singularPool.length > 0 ? singularPool : representatives;
    const holdPick = holdPool.reduce((a, b) => (holdRank(b) > holdRank(a) ? b : a)).candidate;

    const arcOrdered = orderForArc(
      representatives.map((r) => r.candidate),
      holdPick
    );
    const { ordered, correctedAssetFileNames } = enforceChronologicalOrder(arcOrdered, holdPick);

    const allocation = allocateDurations(ordered, holdPick, targetDurationSec, profile);
    if (allocation.warningMessage) {
      throw new Error(allocation.warningMessage);
    }

    const editorialNotes = buildEditorialNotes(
      profile,
      representatives,
      fullyCut,
      holdPick,
      allocation.clips,
      targetDurationSec,
      flattened.excludedSceneCount,
      correctedAssetFileNames
    );

    const totalLen = allocation.clips.length > 0 ? allocation.clips[allocation.clips.length - 1].clip.endSec : 0;
    const warnings: string[] = [];
    // The opposite of the "too much footage" edge case above: there simply
    // isn't enough usable content to reach the target even using every
    // clip at its full native length. That case doesn't throw (a shorter
    // real video is still a valid result), but it must not fail silently —
    // the stress test found this only ever showed up buried in
    // editorialNotes text that nothing in the UI displayed.
    if (targetDurationSec - totalLen > TARGET_BUFFER_SEC) {
      warnings.push(
        `Not enough usable footage to reach the ${targetDurationSec}s target — assembled ${totalLen.toFixed(1)}s instead (${(targetDurationSec - totalLen).toFixed(1)}s short). Add more clips or lower the target length.`
      );
    }

    return {
      id: makeId("plan"),
      targetDurationSec,
      prompt,
      styleSummary: profile.confirmed
        ? `${style.summary} Applying ${profile.displayName}'s confirmed editing profile.`
        : `${style.summary} No confirmed creator profile matched this prompt — using generic pattern logic only.`,
      pacing: style.pacing,
      clips: allocation.clips.map((c) => c.clip),
      musicSuggestion: pickMusic(style.pacing),
      createdAt: new Date().toISOString(),
      editorialNotes,
      holdLongestClipId: allocation.clips.find((c) => c.candidate === holdPick)?.clip.id,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}

/** Enforces a minimum usable scene duration *before* scenes ever become
 *  plannable candidates — a scene shorter than `profile.minSceneSec` is
 *  merged into an adjacent scene from the same clip, extended using
 *  whatever slack the source footage has, or excluded outright, in that
 *  priority order. Never mutates the scenes it's given (works on copies),
 *  since the caller may still hold a reference to the original
 *  understanding result. Skipped entirely for a profile that explicitly
 *  documents intentional flash cuts as part of its confirmed style. */
function enforceMinimumSceneDuration(
  scenes: DetectedScene[],
  assetDurationSec: number,
  profile: CreatorStyleProfile
): { scenes: DetectedScene[]; excludedCount: number } {
  if (profile.allowsFlashCuts) return { scenes, excludedCount: 0 };

  const minSec = profile.minSceneSec;
  const working: DetectedScene[] = scenes.map((s) => ({ ...s, objects: [...s.objects], actions: [...s.actions] }));
  const result: DetectedScene[] = [];
  let excludedCount = 0;

  for (let i = 0; i < working.length; i++) {
    const scene = working[i];
    const len = scene.endSec - scene.startSec;
    if (len >= minSec) {
      result.push(scene);
      continue;
    }

    // Prefer merging into the immediately-preceding kept scene — this is
    // the common case (a Twelve-Labs-detected shot boundary that's just
    // too short) and preserves the most context.
    const prev = result[result.length - 1];
    if (prev && scene.startSec - prev.endSec < 0.5) {
      prev.endSec = scene.endSec;
      prev.description = `${prev.description} ${scene.description}`.trim();
      prev.objects = Array.from(new Set([...prev.objects, ...scene.objects]));
      prev.actions = Array.from(new Set([...prev.actions, ...scene.actions]));
      continue;
    }

    // No valid previous scene to merge into (e.g. this is the first scene
    // in the clip) — try merging forward into the next one instead.
    const next = working[i + 1];
    if (next && next.startSec - scene.endSec < 0.5) {
      working[i + 1] = {
        ...next,
        startSec: scene.startSec,
        description: `${scene.description} ${next.description}`.trim(),
        objects: Array.from(new Set([...scene.objects, ...next.objects])),
        actions: Array.from(new Set([...scene.actions, ...next.actions])),
      };
      continue;
    }

    // Isolated short scene with nothing adjacent to merge into — extend it
    // using whatever slack the source clip has left, if any.
    const extendedEnd = Math.min(assetDurationSec, scene.startSec + minSec);
    if (extendedEnd - scene.startSec >= minSec) {
      result.push({ ...scene, endSec: extendedEnd });
      continue;
    }

    // Can't merge or extend — including this would be a sub-floor
    // flash-cut glitch, so it's dropped rather than kept.
    excludedCount += 1;
  }

  return { scenes: result, excludedCount };
}

function flattenScenes(
  assets: MediaAsset[],
  understanding: VideoUnderstandingResult,
  profile: CreatorStyleProfile
): { candidates: SceneCandidate[]; excludedSceneCount: number } {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const candidates: SceneCandidate[] = [];
  let excludedSceneCount = 0;

  for (const summary of understanding.assetSummaries) {
    const asset = byId.get(summary.assetId);
    if (!asset || asset.kind !== "video") continue;

    const rawScenes: DetectedScene[] =
      summary.scenes && summary.scenes.length > 0
        ? summary.scenes
        : [{ startSec: 0, endSec: asset.durationSec, description: summary.summary, objects: summary.tags, actions: [] }];

    const { scenes, excludedCount } = enforceMinimumSceneDuration(rawScenes, asset.durationSec, profile);
    excludedSceneCount += excludedCount;

    for (const scene of scenes) {
      candidates.push({
        asset,
        scene,
        nativeLen: Math.max(0.1, scene.endSec - scene.startSec),
        category: null,
        holdScore: 0,
        punchlineAnchorStart: scene.startSec,
        punchlineWindowLen: Math.max(0.1, scene.endSec - scene.startSec),
      });
    }
  }

  return { candidates, excludedSceneCount };
}

function haystackOf(scene: DetectedScene): string {
  return [scene.description, ...scene.objects, ...scene.actions].join(" ").toLowerCase();
}

function matchCategory(
  scene: DetectedScene,
  profile: CreatorStyleProfile
): CreatorStyleProfile["cutCategories"][number] | null {
  const hay = haystackOf(scene);
  for (const category of profile.cutCategories) {
    if (category.keywords.some((kw) => hay.includes(kw))) return category;
  }
  return null;
}

function holdScoreOf(scene: DetectedScene, profile: CreatorStyleProfile): number {
  const hay = haystackOf(scene);
  let score = 0;
  for (const signal of profile.holdSignals) {
    if (signal.keywords.some((kw) => hay.includes(kw))) score += signal.weight;
  }
  return score;
}

/** Where an uncategorized clip's punchline-window trim should sit. Uses
 *  the same signal logic as hold-longest detection (`holdScoreOf` via
 *  `profile.holdSignals`) to decide whether there's a detected payoff at
 *  all: if so, anchor a lead-in+tail window on the scene's midpoint (the
 *  best available proxy for "where the moment is" without finer-than-
 *  scene timing data from the understanding vendor); if not, fall back to
 *  a flat capped window from the top of the scene rather than its full
 *  length. Categorized candidates don't use this at all (their own
 *  retention-multiplier ceiling governs them instead) but still get a
 *  well-defined full-scene window for consistency. */
function computePunchlineWindow(c: SceneCandidate, profile: CreatorStyleProfile): { start: number; len: number } {
  const { scene, nativeLen, holdScore, category } = c;

  if (category) {
    return { start: scene.startSec, len: nativeLen };
  }

  const idealLen = holdScore > 0 ? profile.punchline.leadInSec + profile.punchline.tailSec : profile.punchline.defaultCapSec;

  if (idealLen >= nativeLen) {
    // Already shorter than (or equal to) the punchline window — nothing to
    // trim down to, keep it whole.
    return { start: scene.startSec, len: nativeLen };
  }

  if (holdScore === 0) {
    // No detected signal at all — no basis to prefer the middle of the
    // clip over the start, so just take a quick beat from the top.
    return { start: scene.startSec, len: idealLen };
  }

  const anchor = scene.startSec + nativeLen / 2;
  let start = Math.max(scene.startSec, anchor - profile.punchline.leadInSec);
  let end = Math.min(scene.endSec, anchor + profile.punchline.tailSec);

  // If the anchor sat near one edge of the scene, one side of the window
  // got clipped short by the scene boundary — reclaim that from the other
  // side (which has room, since idealLen < nativeLen was already checked)
  // so the window still totals leadIn+tail rather than coming up short.
  if (end - start < idealLen) {
    const deficit = idealLen - (end - start);
    start = Math.max(scene.startSec, start - deficit);
    end = Math.min(scene.endSec, start + idealLen);
  }

  return { start, len: Math.max(0.1, end - start) };
}

/** Coarse but explainable stand-in for real similarity — clusters scenes
 *  whose objects+actions word sets substantially overlap, the same way
 *  redundant takes (e.g. six near-identical bowling-strike clips) were
 *  grouped by hand when the confirmed profiles were built. */
function wordSet(scene: DetectedScene): Set<string> {
  return new Set(
    [...scene.objects, ...scene.actions]
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

const REDUNDANCY_THRESHOLD = 0.4;

function clusterByRedundancy(candidates: SceneCandidate[]): SceneCandidate[][] {
  const sets = candidates.map((c) => wordSet(c.scene));
  const assigned = new Array(candidates.length).fill(-1);
  const clusters: number[][] = [];

  for (let i = 0; i < candidates.length; i++) {
    if (assigned[i] !== -1) continue;
    const cluster = [i];
    assigned[i] = clusters.length;
    for (let j = i + 1; j < candidates.length; j++) {
      if (assigned[j] !== -1) continue;
      if (jaccard(sets[i], sets[j]) >= REDUNDANCY_THRESHOLD) {
        cluster.push(j);
        assigned[j] = clusters.length;
      }
    }
    clusters.push(cluster);
  }

  return clusters.map((idxs) => idxs.map((i) => candidates[i]));
}

function isBetterCandidate(candidate: SceneCandidate, current: SceneCandidate): boolean {
  if (candidate.holdScore !== current.holdScore) return candidate.holdScore > current.holdScore;
  return candidate.nativeLen > current.nativeLen;
}

/** Hold-longest ranking: signal keywords dominate (a scene either reads as
 *  a payoff/awe moment or it doesn't), native length is a capped tiebreak
 *  so an unrelated but very long clip can't win purely on duration. */
function holdRank(r: { candidate: SceneCandidate }): number {
  return r.candidate.holdScore * 10 + Math.min(r.candidate.nativeLen, 20);
}

function orderForArc(candidates: SceneCandidate[], holdPick: SceneCandidate): SceneCandidate[] {
  const rest = candidates.filter((c) => c !== holdPick);
  // Calm-open -> build -> peak -> wind-down: the hold moment lands around
  // two-thirds of the way through, not necessarily where it fell in the
  // raw chronology (confirmed edits reorder for pacing, e.g. the Rome
  // pair's street-sweeper insert was pulled out of chronological order).
  const peakIndex = Math.round(rest.length * 0.65);
  return [...rest.slice(0, peakIndex), holdPick, ...rest.slice(peakIndex)];
}

/** Structural check run right before duration allocation: if two or more
 *  clips share a source asset, their relative order in the sequence must
 *  match their original chronological order in that source — otherwise
 *  same-location/same-subject clips can end up stitched together out of
 *  sequence, producing the jarring same-source whiplash cuts found in
 *  testing (four moments from one bowling-alley recording, stitched in
 *  15s/7s/24s/44s order instead of their own chronology).
 *
 *  The single deliberate exception is the hold pick's own repositioning
 *  to the arc's peak — that's pinned and never touched here, and it's
 *  already explained in editorialNotes ("holding longest on..."), which
 *  is what "the editorial reasoning explicitly justifies breaking it"
 *  means in this codebase: there is no other mechanism that reorders
 *  anything, so any other violation is a clustering side-effect, not a
 *  deliberate choice, and gets corrected back to chronological order.
 *
 *  Positions in the sequence are preserved (so the calm/peak/wind-down
 *  shape from orderForArc is undisturbed) — only *which* same-asset clip
 *  occupies which of its own asset's slots gets reassigned. */
function enforceChronologicalOrder(
  ordered: SceneCandidate[],
  holdPick: SceneCandidate
): { ordered: SceneCandidate[]; correctedAssetFileNames: string[] } {
  const positionsByAsset = new Map<string, number[]>();
  ordered.forEach((c, i) => {
    if (c === holdPick) return; // pinned — the one deliberate reordering, never touched
    const list = positionsByAsset.get(c.asset.id) ?? [];
    list.push(i);
    positionsByAsset.set(c.asset.id, list);
  });

  const result = [...ordered];
  const correctedAssetFileNames: string[] = [];

  for (const positions of positionsByAsset.values()) {
    if (positions.length < 2) continue;

    const clipsAtPositions = positions.map((p) => ordered[p]);
    const chronological = [...clipsAtPositions].sort((a, b) => a.scene.startSec - b.scene.startSec);
    const alreadyChronological = clipsAtPositions.every((c, i) => c === chronological[i]);
    if (alreadyChronological) continue;

    positions.forEach((pos, i) => {
      result[pos] = chronological[i];
    });
    correctedAssetFileNames.push(clipsAtPositions[0].asset.fileName);
  }

  return { ordered: result, correctedAssetFileNames };
}

function allocateDurations(
  ordered: SceneCandidate[],
  holdPick: SceneCandidate,
  targetDurationSec: number,
  profile: CreatorStyleProfile
): { clips: AllocatedClip[]; warningMessage: string | null } {
  // A held shot chopped down to a sliver stops being a "hold" at all, so
  // its tightest-possible floor is deliberately larger than an ordinary
  // clip's — everything else floors at the profile's generic minimum,
  // discounted further for partially-retained categories (e.g. downtime
  // footage that survived at all should still stay brief).
  // The floor is a *minimum output clip length*, not just a minimum input
  // scene length — a heavily-discounted category (e.g. a 0.05x downtime
  // retention multiplier) could otherwise water down to a sub-1s sliver
  // even though enforceMinimumSceneDuration already guaranteed the scene
  // itself started out at least profile.minSceneSec long. Structurally tie
  // the floor to minSceneSec (unless the profile explicitly allows flash
  // cuts) so no amount of category discounting can push a surviving clip
  // below the same floor a raw scene has to clear to exist at all.
  const outputFloor = profile.allowsFlashCuts ? 0.1 : profile.minSceneSec;
  const floors = ordered.map((c) => {
    if (c === holdPick) return Math.min(c.nativeLen, Math.max(outputFloor, 3, c.nativeLen * 0.6));
    const categoryFloor = profile.minKeptClipSec * Math.max(c.category?.retentionMultiplier ?? 1, 0.3);
    return Math.max(outputFloor, Math.min(c.nativeLen, categoryFloor));
  });

  const tightestTotal = floors.reduce((sum, len) => sum + len, 0);

  if (tightestTotal > targetDurationSec + TARGET_BUFFER_SEC) {
    const rankedByCuttability = ordered
      .map((c, i) => ({ candidate: c, floor: floors[i] }))
      .filter((x) => x.candidate !== holdPick)
      .sort((a, b) => holdRank({ candidate: a.candidate }) - holdRank({ candidate: b.candidate }));

    const gap = tightestTotal - (targetDurationSec + TARGET_BUFFER_SEC);
    const suggestions: string[] = [];
    let recovered = 0;
    for (const { candidate, floor } of rankedByCuttability) {
      if (recovered >= gap) break;
      suggestions.push(`cut "${candidate.scene.description}" from ${candidate.asset.fileName} (~${floor.toFixed(1)}s)`);
      recovered += floor;
    }

    const message =
      `Target is ${targetDurationSec}s (±${TARGET_BUFFER_SEC}s buffer), but even the tightest possible cut — ` +
      `single best take of everything, nothing redundant kept — runs ${tightestTotal.toFixed(1)}s, ` +
      `${(tightestTotal - targetDurationSec).toFixed(1)}s over target. To close the gap, cut further: ${suggestions.join("; ")}.`;

    return { clips: [], warningMessage: message };
  }

  const holdIndex = ordered.indexOf(holdPick);
  const holdLen = Math.min(holdPick.nativeLen, Math.max(floors[holdIndex], targetDurationSec * 0.4));

  const others = ordered.filter((_, i) => i !== holdIndex);
  const otherFloors = floors.filter((_, i) => i !== holdIndex);
  const remainingBudget = Math.max(
    otherFloors.reduce((sum, len) => sum + len, 0),
    targetDurationSec - holdLen
  );

  const weights = others.map((c) => 1 + c.holdScore * 0.5);

  // A partially-retained category (e.g. screen-distraction footage) caps
  // out well below its native length even when there's slack budget, and
  // an uncategorized "gag" clip caps out at its punchline window rather
  // than its full native length — the retention multiplier / punchline
  // window is a ceiling on how much of it survives, not just a floor on
  // the minimum. Fully-kept categorized clips are unaffected: their
  // ceiling is just their native length.
  const ceilings = others.map((c) => (c.category ? c.nativeLen * (c.category.retentionMultiplier ?? 1) : c.punchlineWindowLen));

  // Water-fill: start everyone at their floor, then hand out the remaining
  // budget proportionally to weight, but only to clips still under their
  // ceiling — so budget a capped clip can't absorb goes to the others
  // instead of just being left unused (which would land the total under
  // the target for no reason when there's real footage available to fill it).
  const otherLens = [...otherFloors];
  let leftover = remainingBudget - otherLens.reduce((sum, l) => sum + l, 0);
  for (let pass = 0; pass < 10 && leftover > 0.01; pass++) {
    const openIdx = otherLens.map((l, i) => (l < ceilings[i] - 0.01 ? i : -1)).filter((i) => i >= 0);
    if (openIdx.length === 0) break;
    const openWeightSum = openIdx.reduce((sum, i) => sum + weights[i], 0);
    let distributed = 0;
    for (const i of openIdx) {
      const share = (weights[i] / openWeightSum) * leftover;
      const give = Math.min(share, ceilings[i] - otherLens[i]);
      otherLens[i] += give;
      distributed += give;
    }
    leftover -= distributed;
    if (distributed < 0.01) break;
  }

  let otherCursor = 0;
  const lens = ordered.map((_c, i) => (i === holdIndex ? holdLen : otherLens[otherCursor++]));

  let cursor = 0;
  const clips: AllocatedClip[] = ordered.map((c, i) => {
    const len = Math.round(lens[i] * 10) / 10;
    const start = Math.round(cursor * 10) / 10;
    const end = Math.round((start + len) * 10) / 10;
    cursor = end;

    // The hold pick and any categorized clip trim from the start of their
    // own detected scene, exactly as before. An uncategorized "gag" clip
    // trims from its computed punchline-window anchor instead, so what
    // survives is centered on its likely payoff moment rather than
    // whatever happened to be at the top of the raw scene.
    const trimStart = c === holdPick || c.category ? c.scene.startSec : c.punchlineAnchorStart;
    const sourceInSec = Math.round(trimStart * 10) / 10;
    const sourceOutSec = Math.round(Math.min(c.scene.endSec, trimStart + len) * 10) / 10;

    const clip: TimelineClip = {
      id: makeId("clip"),
      sourceAssetId: c.asset.id,
      label: c.asset.fileName.replace(/\.[a-z0-9]+$/i, "") || "Clip",
      thumbColor: CLIP_COLORS[i % CLIP_COLORS.length],
      startSec: start,
      endSec: end,
      transitionIn: i === 0 ? "cut" : profile.transitionDefault,
      overlays: [],
      sourceInSec,
      sourceOutSec,
      speedMultiplier: 1,
      muted: false,
    };

    return { candidate: c, clip };
  });

  return { clips, warningMessage: null };
}

function buildEditorialNotes(
  profile: CreatorStyleProfile,
  representatives: Representative[],
  fullyCut: SceneCandidate[],
  holdPick: SceneCandidate,
  clips: AllocatedClip[],
  targetDurationSec: number,
  excludedSceneCount: number,
  correctedAssetFileNames: string[]
): string[] {
  const notes: string[] = [
    profile.confirmed
      ? `Applying ${profile.displayName}'s confirmed style profile.`
      : `No confirmed creator profile matched this prompt — using generic pattern logic only, not a verified editing signature.`,
  ];

  if (excludedSceneCount > 0) {
    notes.push(
      `Excluded ${excludedSceneCount} detected scene${excludedSceneCount === 1 ? "" : "s"} under ${profile.minSceneSec}s that couldn't be merged into a neighboring scene or extended — a clip that short reads as a flash-cut glitch, not an intentional edit.`
    );
  }

  const cutByCategory = new Map<string, { count: number; citation: string }>();
  for (const c of fullyCut) {
    const key = c.category!.name;
    const entry = cutByCategory.get(key);
    if (entry) entry.count += 1;
    else cutByCategory.set(key, { count: 1, citation: c.category!.citation });
  }
  for (const [name, { count, citation }] of cutByCategory) {
    notes.push(`Cut ${count} scene${count === 1 ? "" : "s"} in full as "${name}" — ${citation}`);
  }

  for (const r of representatives.filter((rep) => rep.clusterSize > 1)) {
    notes.push(
      `Kept only the best of ${r.clusterSize} similar takes ("${r.candidate.scene.description}") — redundant takes of the same beat collapse to one representative.`
    );
  }

  for (const { candidate, clip } of clips) {
    if (candidate === holdPick || candidate.category) continue;
    const kept = clip.endSec - clip.startSec;
    if (kept < candidate.nativeLen - 0.15) {
      notes.push(
        `Trimmed "${candidate.scene.description}" to its payoff moment (${kept.toFixed(1)}s of ${candidate.nativeLen.toFixed(1)}s native) instead of keeping the full clip.`
      );
    }
  }

  for (const fileName of correctedAssetFileNames) {
    notes.push(
      `Reordered clips from ${fileName} back into their original chronological order to avoid a jarring same-source jump cut.`
    );
  }

  const holdClip = clips.find((c) => c.candidate === holdPick)?.clip;
  const holdLenText = holdClip ? ` (${(holdClip.endSec - holdClip.startSec).toFixed(1)}s)` : "";
  notes.push(
    `Holding longest on "${holdPick.scene.description}"${holdLenText} — the single non-repeatable payoff/awe moment, not routine footage.`
  );

  const totalLen = clips.length > 0 ? clips[clips.length - 1].clip.endSec : 0;
  notes.push(`Assembled ${clips.length} clip${clips.length === 1 ? "" : "s"} totalling ${totalLen.toFixed(1)}s against a ${targetDurationSec}s target.`);

  return notes;
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
