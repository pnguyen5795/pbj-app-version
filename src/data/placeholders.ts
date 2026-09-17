// Every invented/placeholder value in this prototype pass lives here —
// nowhere else. Each is rendered at its call site wrapped in <Placeholder>
// (src/components/Placeholder.tsx) so it's visually obvious which parts of
// the app are real vs. stand-ins for backend work Paul hasn't built yet,
// and so removing the fake-data styling later is a one-component change.
//
// NOT included here: static product copy/taxonomy that isn't standing in
// for a future real value (e.g. the "your style" category chip names, or
// button labels) — those are real content, not placeholders for data.

// ---- Sign in --------------------------------------------------------
export const SOCIAL_PROOF_COUNT = "11,376";

// ---- Teach it (state B: analyzing) ----------------------------------
export const TEACH_IT_OBSERVATIONS = [
  "You Cut Every 1.8 Seconds",
  "You Punch in on Reactions",
  "You Never Let a Shot Sit",
  "You Always Lead With the Punchline",
  "You Love a Hard Cut on the Beat",
];

// ---- Teach it (state C: style card) ----------------------------------
export const GENERATED_STYLE_NAME = "Fast & Punchy";

// ---- New project: tier caps -------------------------------------------
export interface TierCap {
  name: "Basic" | "Intermediate" | "Pro";
  outputMinutes: number;
  footageHours: number;
}

export const TIER_CAPS: TierCap[] = [
  { name: "Basic", outputMinutes: 3, footageHours: 1 },
  { name: "Intermediate", outputMinutes: 5, footageHours: 2 },
  { name: "Pro", outputMinutes: 10, footageHours: 4 },
];

// Which tier the signed-in creator is on — fake until real billing exists.
export const CURRENT_TIER: TierCap["name"] = "Basic";

// Not fake data — real placeholder text for the real recipe input on New
// Project screen 2 only. Lowercase is deliberate brand voice (same
// exception class as "let's cook" on Sign In), not an oversight in the
// app-wide title-case pass.
export const PROMPT_PLACEHOLDER = "write your recipe";

// Stand-in art for a clip whose real thumbnail couldn't be captured (e.g.
// this environment defers video decode for backgrounded tabs, so the
// off-DOM capture below times out) — same gray-gradient language as the
// Projects grid's fake thumbnails.
export const PLACEHOLDER_CLIP_GRADIENTS = [
  "linear-gradient(160deg, #d1d1d6, #aeaeb2)",
  "linear-gradient(160deg, #c7c7cc, #8e8e93)",
  "linear-gradient(160deg, #aeaeb2, #636366)",
];

// New project screen 2: the creator's own trained styles (not generic
// presets — those were cut). Real content shape, fake data until there's a
// real trained-style backend. isDefault distinguishes system-shipped
// styles from a creator's own trained ones — all 6 are defaults for now;
// there's no user-trained style yet to compare against, so no visual
// sectioning is needed (see NewProjectPrompt). phrase is the short,
// lowercase description shown under the style name once it's added to
// the ingredients list — kept here rather than inline in the component so
// content and component stay separate.
export interface TrainedStyle {
  id: string;
  label: string;
  phrase: string;
  isDefault: boolean;
}

export const TRAINED_STYLES: TrainedStyle[] = [
  { id: "fast-punchy", label: "Fast & Punchy", phrase: "quick cuts, tight pacing, no dead air", isDefault: true },
  { id: "clean", label: "Clean", phrase: "simple cuts, let it breathe, minimal effects", isDefault: true },
  { id: "loud", label: "Loud", phrase: "punch in hard, big captions, high energy", isDefault: true },
  { id: "slow-burn", label: "Slow Burn", phrase: "long takes, slow build, patient pacing", isDefault: true },
  { id: "talky", label: "Talky", phrase: "cut to the talking, trim every pause", isDefault: true },
  { id: "chaotic", label: "Chaotic", phrase: "fast zooms, hard cuts, keep it unpredictable", isDefault: true },
];

// Studio's edit-explanation line (collapsed summary + expanded per-
// ingredient reasoning). Both fields are plain English — no kitchen
// language — since this is an instruction surface, not marketing copy.
export interface EditExplanation {
  summary: string;
  reasoning: string;
}

const NO_INGREDIENTS_EXPLANATION: EditExplanation = {
  summary: "cut to match your recipe, no ingredients applied",
  reasoning: "No ingredients were added, so pacing and cuts followed your written recipe alone.",
};

// SWAP POINT: stands in for whatever Paul's real generation engine
// returns alongside the rendered video — a real explanation of the
// edit it actually made, not one synthesized from the inputs after the
// fact. This placeholder can only work from what's already available
// client-side (the selected ingredients' own phrase copy), so `prompt`
// is accepted for interface parity with what the real engine will need
// but isn't actually used yet — there's no real language understanding
// here to fold the freeform text into a sentence honestly. Replace this
// whole function with a read of the real engine's returned explanation
// field; delete prompt/styleIds-based synthesis entirely once that
// exists.
export function getEditExplanation(prompt: string, styleIds: string[]): EditExplanation {
  void prompt;
  const styles = styleIds
    .map((id) => TRAINED_STYLES.find((s) => s.id === id))
    .filter((s): s is TrainedStyle => s !== undefined);

  if (styles.length === 0) return NO_INGREDIENTS_EXPLANATION;

  return {
    summary: styles.map((s) => s.phrase).join(", "),
    reasoning: styles.map((s) => `${s.label} — ${s.phrase}.`).join(" "),
  };
}

// ---- Cooking ----------------------------------------------------------
// How long the fake progress animation takes to reach 100%. Isolated here
// (and only read by the useFakeProgress hook) so swapping in a real
// progress source later is a one-hook change, not a component rewrite.
export const FAKE_COOKING_DURATION_MS = 9000;

// Rotates every ~3s in the status block's "current action" line — see
// Cooking.tsx. Exact copy from the redesign task spec; lowercase-first
// sentence case (not Title Case) is deliberate here, matching how iOS
// itself writes transient status text (e.g. "Updating…", not "Updating
// Now"), not this app's usual title-case convention.
export const COOKING_NARRATION = [
  "Analyzing your footage",
  "Matching your pace",
  "Chopping your clips",
  "Seasoning the cut",
  "Almost ready",
];

// Placeholder ETA, in minutes, for the status block's "~X min left" line
// — there's no real render-time estimate yet. SWAP POINT: once Paul's
// engine can report a real ETA, replace every read of this constant with
// that value (or the "Estimating…"/"Order coming up" fallback states)
// wired through the same prop Cooking.tsx already takes progress on.
export const FAKE_ETA_MINUTES = 4;

// ---- Projects grid ------------------------------------------------------
export interface FakeProject {
  id: string;
  title: string;
  durationLabel: string;
  thumbGradient: string;
  // True for a finished render the creator hasn't watched yet — drives the
  // unread blue dot in My Projects (see ExistingProjects.tsx). Clears on
  // actual playback in Studio, not on merely opening the row.
  unread: boolean;
}

export const FAKE_PROJECTS: FakeProject[] = [
  { id: "proj_1", title: "Beach Day Recap", durationLabel: "0:32", thumbGradient: "linear-gradient(160deg, #d1d1d6, #aeaeb2)", unread: false },
  { id: "proj_2", title: "Weekend in Tulum", durationLabel: "0:45", thumbGradient: "linear-gradient(160deg, #c7c7cc, #8e8e93)", unread: false },
  { id: "proj_3", title: "Studio Session", durationLabel: "0:28", thumbGradient: "linear-gradient(160deg, #aeaeb2, #636366)", unread: false },
  { id: "proj_4", title: "Road Trip Edit", durationLabel: "1:02", thumbGradient: "linear-gradient(160deg, #e5e5ea, #c7c7cc)", unread: false },
  { id: "proj_5", title: "Golden Hour", durationLabel: "0:38", thumbGradient: "linear-gradient(160deg, #8e8e93, #636366)", unread: false },
  { id: "proj_6", title: "Friends Vlog", durationLabel: "0:51", thumbGradient: "linear-gradient(160deg, #d1d1d6, #8e8e93)", unread: false },
];

// Cycled by id hash for a freshly-finished render's thumbnail — there's no
// real frame to grab yet, so this just keeps new project cards visually
// consistent with the hand-picked gradients above rather than defaulting
// to one repeated color.
export const PROJECT_THUMB_GRADIENTS = [
  "linear-gradient(160deg, #d1d1d6, #aeaeb2)",
  "linear-gradient(160deg, #c7c7cc, #8e8e93)",
  "linear-gradient(160deg, #aeaeb2, #636366)",
  "linear-gradient(160deg, #e5e5ea, #c7c7cc)",
  "linear-gradient(160deg, #8e8e93, #636366)",
  "linear-gradient(160deg, #d1d1d6, #8e8e93)",
];

// ---- Studio: mock AI-arranged timeline ---------------------------------
// Fallback ONLY — used when Studio genuinely has no real uploaded clips to
// show (e.g. opening an existing project, which isn't backed by real footage
// yet). When a real New project draft carries real clips, Studio uses those
// instead of this. thumbBackground is a plain gray gradient here since it's
// fake, but the same field on a real clip holds a real `url(...)` thumbnail
// — see Studio.tsx's WorkingClip.
export interface TimelineClip {
  id: string;
  thumbBackground: string;
  durationSec: number;
}

export const MOCK_TIMELINE_CLIPS: TimelineClip[] = [
  { id: "snip_1", thumbBackground: "linear-gradient(160deg, #d1d1d6, #aeaeb2)", durationSec: 3.2 },
  { id: "snip_2", thumbBackground: "linear-gradient(160deg, #c7c7cc, #8e8e93)", durationSec: 2.4 },
  { id: "snip_3", thumbBackground: "linear-gradient(160deg, #aeaeb2, #636366)", durationSec: 4.1 },
  { id: "snip_4", thumbBackground: "linear-gradient(160deg, #e5e5ea, #c7c7cc)", durationSec: 1.8 },
  { id: "snip_5", thumbBackground: "linear-gradient(160deg, #8e8e93, #636366)", durationSec: 3.6 },
  { id: "snip_6", thumbBackground: "linear-gradient(160deg, #d1d1d6, #8e8e93)", durationSec: 2.2 },
  { id: "snip_7", thumbBackground: "linear-gradient(160deg, #c7c7cc, #aeaeb2)", durationSec: 3.0 },
  { id: "snip_8", thumbBackground: "linear-gradient(160deg, #aeaeb2, #8e8e93)", durationSec: 2.7 },
];

// The one line under Studio's preview that's the app's actual trust
// moment — proof the edit came from the creator's own footage/style, not a
// template. Same voice as TEACH_IT_OBSERVATIONS (specific, observational,
// second person, lowercase), and literally references GENERATED_STYLE_NAME
// rather than repeating it as a second, disconnected string. Real
// generation is backend work; honest stand-in text until that exists.
export const EDIT_RECEIPT =
  `Fast Cuts, Punchy Reactions, Zero Dead Air — Pulled Straight From Your ${GENERATED_STYLE_NAME} Style`;

// Not fake data — real placeholder text for the real revision-prompt input.
// Scope changes automatically based on whether a clip is selected — see
// Studio.tsx's prompt bar.
export const REVISION_PROMPT_PLACEHOLDER = "Want to Change Anything About This Edit?";
export const REVISION_PROMPT_PLACEHOLDER_CLIP = "Change Just This Clip";

// ---- Settings / usage meter (moved from the old mockAccount.ts) --------
export interface MockBilling {
  tier: "Free" | "Pro" | "Studio";
  minutesUsed: number;
  minutesLimit: number;
}

export const MOCK_BILLING: MockBilling = {
  tier: "Free",
  minutesUsed: 18,
  minutesLimit: 30,
};
