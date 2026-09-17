import fs from "node:fs/promises";
import { TRAINING_DIR, TRAINING_MANIFEST_PATH, LEARNED_ADJUSTMENTS_PATH } from "./paths.js";

export type TrainingProjectType = "finished-only" | "raw-plus-final";
// "queued" = uploaded and persisted, waiting for a free analysis-queue
// slot (see trainingQueue.ts) — distinct from "analyzing" (a Twelve Labs
// call is actively in flight for it right now), so the batch UI can show
// the creator which of those two very different kinds of "waiting" a
// given submission is doing.
export type TrainingProjectStatus = "queued" | "analyzing" | "analyzed" | "failed";
// "Review queue for everything": nothing a submission proposes — including
// a finished-only submission's notes-only additions — reaches the live
// profile until a human explicitly approves it here. Keeps one consistent
// mental model rather than special-casing "low risk" proposals.
export type TrainingReviewStatus = "pending" | "approved" | "rejected" | "none";

export interface TrainingEvidence {
  description: string;
  timestampSec: number;
}

export interface ProposedCutCategory {
  id: string;
  /** Name of an existing cutCategory this would extend (keyword-append),
   *  or null if this would be a wholly new category. */
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
  /** Plain descriptive notes (pacing/tone/shot-type) — never affect
   *  cutCategories/holdSignals, whether from a finished-only submission
   *  (which can *only* ever produce these) or a raw+final one (which adds
   *  them as context alongside its cut/hold proposals). */
  noteProposals: string[];
  conflicts: ProposedConflict[];
}

export interface TrainingFileInfo {
  fileName: string;
  storedPath: string;
  sizeBytes: number;
  durationSec: number;
}

export interface TrainingProject {
  id: string;
  type: TrainingProjectType;
  targetProfileId: string;
  createdAt: string;
  status: TrainingProjectStatus;
  errorMessage?: string;
  files: {
    final: TrainingFileInfo;
    raw?: TrainingFileInfo;
  };
  proposedDiff?: ProposedPatternDiff;
  reviewStatus: TrainingReviewStatus;
  reviewedAt?: string;
  /** Human-readable "what was learned or updated" summary shown right
   *  after processing finishes. */
  summary?: string;
}

type ProjectManifest = Record<string, TrainingProject>;

export interface LearnedAdjustmentsForProfile {
  cutCategoryAdditions: { name: string; keywords: string[]; retentionMultiplier: number; citation: string }[];
  holdSignalAdditions: { keywords: string[]; weight: number }[];
  noteAdditions: string[];
}

export type LearnedAdjustments = Record<string, LearnedAdjustmentsForProfile>;

// Same lazy-load / atomic-write / write-queue-lock pattern as
// analysisCache.ts, duplicated here (rather than shared) since the two
// stores hold unrelated data with independent lifecycles.
let projectManifest: ProjectManifest | null = null;
let projectWriteQueue: Promise<void> = Promise.resolve();

async function loadProjectManifest(): Promise<ProjectManifest> {
  if (projectManifest) return projectManifest;
  try {
    const raw = await fs.readFile(TRAINING_MANIFEST_PATH, "utf8");
    projectManifest = JSON.parse(raw) as ProjectManifest;
  } catch {
    projectManifest = {};
  }
  return projectManifest;
}

async function persistProjectManifest(): Promise<void> {
  const snapshot = projectManifest ?? {};
  projectWriteQueue = projectWriteQueue.then(async () => {
    await fs.mkdir(TRAINING_DIR, { recursive: true });
    const tmpPath = `${TRAINING_MANIFEST_PATH}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2), "utf8");
    await fs.rename(tmpPath, TRAINING_MANIFEST_PATH);
  });
  await projectWriteQueue;
}

export async function listTrainingProjects(): Promise<TrainingProject[]> {
  const m = await loadProjectManifest();
  return Object.values(m).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getTrainingProject(id: string): Promise<TrainingProject | undefined> {
  const m = await loadProjectManifest();
  return m[id];
}

export async function saveTrainingProject(project: TrainingProject): Promise<void> {
  const m = await loadProjectManifest();
  m[project.id] = project;
  await persistProjectManifest();
}

let learnedAdjustments: LearnedAdjustments | null = null;
let learnedWriteQueue: Promise<void> = Promise.resolve();

async function loadLearnedAdjustments(): Promise<LearnedAdjustments> {
  if (learnedAdjustments) return learnedAdjustments;
  try {
    const raw = await fs.readFile(LEARNED_ADJUSTMENTS_PATH, "utf8");
    learnedAdjustments = JSON.parse(raw) as LearnedAdjustments;
  } catch {
    learnedAdjustments = {};
  }
  return learnedAdjustments;
}

async function persistLearnedAdjustments(): Promise<void> {
  const snapshot = learnedAdjustments ?? {};
  learnedWriteQueue = learnedWriteQueue.then(async () => {
    await fs.mkdir(TRAINING_DIR, { recursive: true });
    const tmpPath = `${LEARNED_ADJUSTMENTS_PATH}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2), "utf8");
    await fs.rename(tmpPath, LEARNED_ADJUSTMENTS_PATH);
  });
  await learnedWriteQueue;
}

export async function getLearnedAdjustments(): Promise<LearnedAdjustments> {
  return loadLearnedAdjustments();
}

function emptyBucket(): LearnedAdjustmentsForProfile {
  return { cutCategoryAdditions: [], holdSignalAdditions: [], noteAdditions: [] };
}

/** Applies only the selected proposals from an already-analyzed project
 *  into the live learned-adjustments layer for its target profile. Called
 *  exclusively from the review endpoint — nothing else ever writes here,
 *  which is what makes "review queue for everything" actually hold. */
export async function applyApprovedProposals(
  project: TrainingProject,
  selection: { cutCategoryIds?: string[]; holdSignalIds?: string[]; includeNotes?: boolean }
): Promise<void> {
  const all = await loadLearnedAdjustments();
  const bucket = all[project.targetProfileId] ?? emptyBucket();
  const diff = project.proposedDiff;

  if (diff) {
    for (const proposal of diff.cutCategoryProposals) {
      if (!selection.cutCategoryIds?.includes(proposal.id)) continue;
      bucket.cutCategoryAdditions.push({
        name: proposal.name,
        keywords: proposal.keywords,
        retentionMultiplier: proposal.retentionMultiplier,
        citation: proposal.citation,
      });
    }
    for (const proposal of diff.holdSignalProposals) {
      if (!selection.holdSignalIds?.includes(proposal.id)) continue;
      bucket.holdSignalAdditions.push({ keywords: proposal.keywords, weight: proposal.weight });
    }
    if (selection.includeNotes) {
      bucket.noteAdditions.push(...diff.noteProposals);
    }
  }

  all[project.targetProfileId] = bucket;
  learnedAdjustments = all;
  await persistLearnedAdjustments();
}
