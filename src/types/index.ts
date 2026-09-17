// Core domain types shared across the app and the service layer.
// Keeping these independent of any particular backend/vendor keeps the
// service layer swappable (mock -> Twelve Labs / Shotstack / etc.) later.

export type MediaKind = "video" | "photo";

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  fileName: string;
  /** Local object URL for immediate preview. */
  previewUrl: string;
  /** Duration in seconds; photos are treated as a still with a nominal duration. */
  durationSec: number;
  sizeBytes: number;
}

export type TransitionType = "cut" | "crossfade" | "whip-pan" | "zoom" | "slide";

export interface TextOverlay {
  id: string;
  text: string;
  position: "top" | "center" | "bottom";
  startSec: number;
  endSec: number;
}

export interface TimelineClip {
  id: string;
  sourceAssetId: string;
  label: string;
  /** Thumbnail color/gradient used as a stand-in for a real generated thumbnail. */
  thumbColor: string;
  /** Position in the edited timeline, in seconds. */
  startSec: number;
  endSec: number;
  /** Transition applied at the *start* of this clip (i.e. how it enters). */
  transitionIn: TransitionType;
  overlays: TextOverlay[];
  /** Original source in/out points this clip was trimmed from (for realism). */
  sourceInSec: number;
  sourceOutSec: number;
  /** Playback speed multiplier shown as a filmstrip badge (1 = normal). */
  speedMultiplier: number;
  /** Whether this clip's original audio is muted. */
  muted: boolean;
}

export interface EditPlan {
  id: string;
  targetDurationSec: number;
  prompt: string;
  styleSummary: string;
  pacing: "slow" | "medium" | "fast" | "punchy";
  clips: TimelineClip[];
  musicSuggestion: string;
  createdAt: string;
  /** Human-readable "Play" reasoning behind the keep/cut/hold-longest
   *  decisions below, each line citing the specific confirmed style
   *  pattern it applies. Populated by pattern-driven planners; absent for
   *  planners that don't reason explicitly (e.g. the mock). */
  editorialNotes?: string[];
  /** Id of the clip in `clips` chosen as the single moment to hold longest
   *  on, if the planner made that kind of deliberate choice. */
  holdLongestClipId?: string;
  /** Heads-up messages about this plan the creator should see — e.g. "not
   *  enough usable footage to reach the requested length" — as opposed to
   *  editorialNotes, which explain *why* decisions were made, not that
   *  something may be off. */
  warnings?: string[];
}

export interface ProjectResult {
  id: string;
  videoUrl: string;
  posterUrl: string;
  plan: EditPlan;
  /** Combined warnings from understanding (skipped clips) and planning
   *  (target not fully met) surfaced by the last processing/render run. */
  warnings?: string[];
}

export type AspectRatio = "9:16" | "1:1" | "4:5" | "16:9";
export type ExportResolution = "720p" | "1080p" | "4K";

export interface ExportOptions {
  aspectRatio: AspectRatio;
  resolution: ExportResolution;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export type ProjectStage =
  | "landing"
  | "setup"
  | "processing"
  | "ready"
  | "results"
  | "settings"
  | "projects"
  | "styleLibrary"
  | "styleTraining";

export interface ProjectDraft {
  assets: MediaAsset[];
  targetDurationSec: number;
  prompt: string;
}

/** Optional reference the user can supply alongside the freeform prompt. */
export interface StyleReference {
  /** A pasted link to a reference video (e.g. a creator's post). */
  url?: string;
  /** Id of a chosen preset from the saved/preset style list. */
  presetId?: string;
}

/**
 * A creator-uploaded (or creator-selected) reference clip saved to their
 * Style Library, tagged with a style name. Later, the AI edit pipeline can
 * reference these when generating an edit — see StyleLibraryService.
 */
export interface SavedStyle {
  id: string;
  name: string;
  kind: MediaKind;
  /** Local object URL for an uploaded file; empty for seeded mock entries. */
  previewUrl: string;
  /** Gradient fallback shown when there's no real previewUrl (seed data). */
  thumbColor?: string;
  createdAt: string;
}
