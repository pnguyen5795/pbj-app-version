// Runs a Style Training batch's upload+analysis pipeline entirely outside
// any screen component's lifecycle. StyleTraining.tsx used to own this as
// local component state, which meant navigating away mid-batch silently
// orphaned the in-flight work from the UI's perspective (React state
// updates on an unmounted component are just dropped) and there was
// nowhere else in the app to see it was still running. Moving it to a
// plain module-level store — subscribed to via useSyncExternalStore —
// means the batch keeps running and reporting progress no matter what
// screen is currently mounted, and a persistent app-wide badge (see
// AppStatusBadge.tsx) can show it from anywhere.
//
// The upload concurrency, poll cadence, and status mapping here are
// unchanged from before — this is a relocation, not a behavior change.
import type { TrainingProject, TrainingProjectType, TrainingProjectStatus } from "../services/interfaces";
import { styleTrainingService } from "../services";
import { mapWithConcurrency, delay } from "../utils/concurrency";
import { addNotification } from "./notificationCenter";

export type BatchItemStatus = "uploading" | "queued" | "analyzing" | "done" | "failed";

export interface BatchItem {
  id: string;
  fileName: string;
  status: BatchItemStatus;
  project?: TrainingProject;
  error?: string;
}

export interface BatchRun {
  id: string;
  startedAt: string;
  items: BatchItem[];
}

export interface BatchSubmissionInput {
  /** Stable client-local id, reused from the StyleTraining draft entry so
   *  the caller can match results back to what it submitted if needed. */
  id: string;
  fileName: string;
  type: TrainingProjectType;
  final: File;
  raw?: File;
}

const UPLOAD_CONCURRENCY = 4;
const POLL_INTERVAL_MS = 2000;
const PENDING_STATUSES: BatchItemStatus[] = ["uploading", "queued", "analyzing"];

let runs: BatchRun[] = [];
const listeners = new Set<() => void>();
// Real OS push notifications aren't available here (see
// notificationCenter.ts) — this is what makes "the creator gets notified
// when the batch finishes" true at all: once every item in a run has
// settled, log one persistent, success/failure-aware entry, exactly once.
const notifiedRuns = new Set<string>();

function emit(): void {
  for (const l of listeners) l();
}

function checkRunComplete(runId: string): void {
  if (notifiedRuns.has(runId)) return;
  const run = runs.find((r) => r.id === runId);
  if (!run || run.items.length === 0) return;
  if (!run.items.every((it) => it.status === "done" || it.status === "failed")) return;
  notifiedRuns.add(runId);
  addNotification({
    kind: "styleTraining",
    total: run.items.length,
    succeeded: run.items.filter((it) => it.status === "done").length,
    failed: run.items.filter((it) => it.status === "failed").length,
  });
}

export function subscribeTrainingBatches(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTrainingBatchesSnapshot(): BatchRun[] {
  return runs;
}

function mapServerStatus(status: TrainingProjectStatus): BatchItemStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "analyzing":
      return "analyzing";
    case "analyzed":
      return "done";
    case "failed":
      return "failed";
  }
}

function patchItem(runId: string, itemId: string, patch: Partial<BatchItem>): void {
  runs = runs.map((r) =>
    r.id !== runId ? r : { ...r, items: r.items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)) }
  );
  emit();
  checkRunComplete(runId);
}

export function totalPendingCount(): number {
  return runs.reduce((sum, r) => sum + r.items.filter((it) => PENDING_STATUSES.includes(it.status)).length, 0);
}

export function totalItemCount(): number {
  return runs.reduce((sum, r) => sum + r.items.length, 0);
}

/**
 * Kicks off a batch's upload+analysis pipeline and returns immediately —
 * the caller (a button's onClick) never awaits this, so confirming a
 * batch of any size is a synchronous, instant action. All the real work
 * happens in the fire-and-forget `runBatch` call below.
 */
export function startTrainingBatch(inputs: BatchSubmissionInput[]): string {
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const run: BatchRun = {
    id: runId,
    startedAt: new Date().toISOString(),
    items: inputs.map((i) => ({ id: i.id, fileName: i.fileName, status: "uploading" })),
  };
  runs = [run, ...runs];
  emit();

  void runBatch(runId, inputs);
  return runId;
}

async function runBatch(runId: string, inputs: BatchSubmissionInput[]): Promise<void> {
  const entryToProjectId = new Map<string, string>();

  // Uploads run with real concurrency — a slow Twelve Labs analysis for
  // one file can never hold up the next file's upload, since the server
  // responds as soon as the file is safely stored, not after analysis.
  await mapWithConcurrency(inputs, UPLOAD_CONCURRENCY, async (input) => {
    try {
      const project = await styleTrainingService.submit(input.type, { final: input.final, raw: input.raw });
      entryToProjectId.set(input.id, project.id);
      patchItem(runId, input.id, { status: mapServerStatus(project.status), project });
    } catch (err) {
      patchItem(runId, input.id, { status: "failed", error: err instanceof Error ? err.message : "Upload failed." });
    }
  });

  const stillPending = new Set(entryToProjectId.keys());
  while (stillPending.size > 0) {
    await delay(POLL_INTERVAL_MS);
    const all = await styleTrainingService.listProjects();
    const byId = new Map(all.map((p) => [p.id, p]));
    for (const itemId of stillPending) {
      const projectId = entryToProjectId.get(itemId)!;
      const project = byId.get(projectId);
      if (!project) continue;
      patchItem(runId, itemId, { status: mapServerStatus(project.status), project });
      if (project.status === "analyzed" || project.status === "failed") stillPending.delete(itemId);
    }
  }
}

/** Called by StyleTraining when the creator approves/rejects a
 *  review-pending item — keeps the store's copy of that project in sync
 *  so re-visiting the screen (or the badge) reflects the decision. */
export function updateTrainingBatchProject(updated: TrainingProject): void {
  runs = runs.map((r) => ({
    ...r,
    items: r.items.map((it) => (it.project?.id === updated.id ? { ...it, project: updated } : it)),
  }));
  emit();
}
