// Service-layer interfaces. Every "pretend backend" step in the product
// spec has a matching interface here. The rest of the app only ever talks
// to these interfaces (see index.ts), so swapping the mock implementations
// for real vendors (Twelve Labs, Shotstack, a style-scraper, etc.) later is
// a matter of writing a new class and changing one wiring line — no
// component or screen code needs to change.

import type {
  MediaAsset,
  EditPlan,
  ChatMessage,
  ExportOptions,
  SavedStyle,
  MediaKind,
} from "../types";

/** A single detected shot/scene within one asset — the granularity a real
 *  edit planner needs to make keep/cut/hold-longest decisions (mirrors the
 *  shot-level schema a vendor like Twelve Labs actually returns). */
export interface DetectedScene {
  startSec: number;
  endSec: number;
  description: string;
  objects: string[];
  actions: string[];
}

export interface VideoUnderstandingResult {
  /** Per-asset summary of detected content (mocked). `scenes` is optional
   *  so callers that only have a coarse summary still satisfy the type;
   *  a real edit planner falls back to treating the whole asset as one
   *  scene when it's absent. */
  assetSummaries: { assetId: string; summary: string; tags: string[]; scenes?: DetectedScene[] }[];
  overallSummary: string;
  /** Human-readable notes about anything that didn't fully succeed — e.g.
   *  "IMG_1234.MOV couldn't be analyzed and was skipped: timed out after
   *  90s". Understanding still returns normally as long as at least one
   *  asset succeeded; this is how the skipped ones are surfaced instead of
   *  silently vanishing or failing the whole request. */
  warnings?: string[];
}

export interface VideoUnderstandingService {
  analyze(assets: MediaAsset[]): Promise<VideoUnderstandingResult>;
}

export interface StyleAnalysisResult {
  styleName: string;
  summary: string;
  traits: string[];
  pacing: "slow" | "medium" | "fast" | "punchy";
}

/** Optional style reference passed alongside the prompt — a pasted link
 *  and/or a chosen preset name from the Setup screen's Style Reference
 *  section. */
export interface StyleReferenceInput {
  url?: string;
  presetName?: string;
}

export interface StyleAnalysisService {
  /** Given the freeform prompt (and an optional explicit reference), infer
   *  a referenced creator/aesthetic style. */
  analyze(prompt: string, reference?: StyleReferenceInput): Promise<StyleAnalysisResult>;
}

export interface EditPlanRequest {
  assets: MediaAsset[];
  targetDurationSec: number;
  prompt: string;
  understanding: VideoUnderstandingResult;
  style: StyleAnalysisResult;
}

export interface EditPlanService {
  generate(request: EditPlanRequest): Promise<EditPlan>;
}

export interface ChatEditResult {
  plan: EditPlan;
  assistantReply: string;
}

export interface ChatEditService {
  /**
   * `contextClipId` is the clip the user was pointed at when they issued
   * the instruction (via tapping the video to pause, scrubbing the
   * timeline, or tapping a clip directly) — used as the implied target
   * for instructions like "extend this clip" that don't name a clip
   * explicitly.
   */
  applyInstruction(
    plan: EditPlan,
    instruction: string,
    history: ChatMessage[],
    contextClipId?: string | null
  ): Promise<ChatEditResult>;
}

export interface RenderResult {
  videoUrl: string;
}

/**
 * Executes an EditPlan's shot list into an actual playable video file (the
 * step that turns the Play + trim points into pixels). The initial
 * processing pass calls this once; the Results screen's explicit "render"
 * action calls it again after manual timeline edits — edits themselves
 * only mutate the plan (see ChatEditService), they don't re-render.
 *
 * `exportOptions`, when passed, means this render is for a specific export
 * (not just an internal preview) — the output is cropped to fill exactly
 * that aspect ratio/resolution, which is what makes picking a different
 * option in the Export sheet actually change the rendered video instead of
 * only the downloaded filename.
 */
export interface RenderService {
  render(plan: EditPlan, exportOptions?: ExportOptions): Promise<RenderResult>;
}

export interface ExportResult {
  success: boolean;
  savedToLibrary: boolean;
  fileName: string;
}

export interface ExportService {
  export(plan: EditPlan, options: ExportOptions): Promise<ExportResult>;
}

/** Progress callback used by the orchestrator to drive the loading screen copy. */
export type ProcessingStep =
  | "uploading"
  | "understanding"
  | "style"
  | "planning"
  | "rendering"
  | "done";

export interface ProcessingOrchestrator {
  run(
    assets: MediaAsset[],
    targetDurationSec: number,
    prompt: string,
    styleReference: StyleReferenceInput | undefined,
    onStep: (step: ProcessingStep) => void
  ): Promise<{ videoUrl: string; posterUrl: string; plan: EditPlan; warnings: string[] }>;
}

/**
 * Manages the creator's Style Library — reference clips (their own past
 * content, or other creators' content) tagged with a style name. This is
 * the seam a real reference-style analysis pipeline (e.g. a vision model
 * that extracts pacing/color/caption traits from the clip) would plug
 * into later: `add` would kick off analysis and `list`/entries would
 * carry the resulting traits alongside the clip.
 */
export interface StyleLibraryService {
  list(): Promise<SavedStyle[]>;
  add(file: { fileName: string; previewUrl: string; kind: MediaKind }, styleName: string): Promise<SavedStyle>;
  remove(id: string): Promise<void>;
}

/**
 * Style Training: creator-submitted raw/final pairs (or finished-only
 * reference clips) used to grow a confirmed CreatorStyleProfile over time.
 * Entirely separate from the regular upload/render flow (its own backend
 * storage, its own endpoints) — see server/src/trainingStore.ts.
 *
 * Every submission's extracted patterns land in a review queue; nothing
 * reaches the live profile until `review(id, "approve", ...)` is called —
 * see patternEditPlanService.ts's use of the learned-adjustments layer
 * this produces.
 */
export type TrainingProjectType = "finished-only" | "raw-plus-final";
// "queued" = uploaded, waiting for a free server-side analysis slot —
// distinct from "analyzing" (a Twelve Labs call is in flight right now).
export type TrainingProjectStatus = "queued" | "analyzing" | "analyzed" | "failed";
export type TrainingReviewStatus = "pending" | "approved" | "rejected" | "none";

export interface TrainingEvidence {
  description: string;
  timestampSec: number;
}

export interface ProposedCutCategory {
  id: string;
  /** Name of an existing cutCategory this would extend, if the server's
   *  heuristic thinks it recognizes one — approximate, not authoritative. */
  matchedExistingName: string | null;
  name: string;
  keywords: string[];
  retentionMultiplier: number;
  citation: string;
  evidence: TrainingEvidence[];
}

export interface ProposedHoldSignal {
  id: string;
  keywords: string[];
  weight: number;
  evidence: TrainingEvidence[];
}

export interface ProposedConflict {
  description: string;
}

export interface ProposedPatternDiff {
  cutCategoryProposals: ProposedCutCategory[];
  holdSignalProposals: ProposedHoldSignal[];
  /** Plain pacing/tone/shot-type notes. Never affect cutCategories or
   *  holdSignals — a finished-only submission can *only* ever produce
   *  these, since there's no raw footage to know what was cut. */
  noteProposals: string[];
  conflicts: ProposedConflict[];
}

export interface TrainingProject {
  id: string;
  type: TrainingProjectType;
  createdAt: string;
  status: TrainingProjectStatus;
  errorMessage?: string;
  finalFileName: string;
  rawFileName?: string;
  proposedDiff?: ProposedPatternDiff;
  reviewStatus: TrainingReviewStatus;
  summary?: string;
}

export interface TrainingReviewSelection {
  cutCategoryIds?: string[];
  holdSignalIds?: string[];
  includeNotes?: boolean;
}

export interface StyleTrainingService {
  listProjects(): Promise<TrainingProject[]>;
  submit(type: TrainingProjectType, files: { final: File; raw?: File }): Promise<TrainingProject>;
  review(id: string, decision: "approve" | "reject", selection?: TrainingReviewSelection): Promise<TrainingProject>;
}
