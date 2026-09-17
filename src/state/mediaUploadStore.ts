// Mirrors trainingBatchStore.ts's approach for the regular (non-Style-
// Training) project upload path: uploads run outside any screen
// component's lifecycle, with real client-side concurrency, so selecting
// files starts real work immediately and that work survives navigating
// away from Setup entirely. MediaPicker.tsx merges completed assets in
// as they arrive instead of awaiting one big blocking upload call.
import type { MediaAsset } from "../types";
import { uploadFiles } from "../services/live/uploadClient";
import { mapWithConcurrency } from "../utils/concurrency";
import { addNotification } from "./notificationCenter";

export type UploadItemStatus = "uploading" | "done" | "failed";

export interface UploadItem {
  id: string;
  fileName: string;
  status: UploadItemStatus;
  asset?: MediaAsset;
  error?: string;
  // Whether a MediaPicker has already folded this completed upload into a
  // project's asset list. Lives here (global store), not as a ref inside
  // MediaPicker, because MediaPicker remounts on every stage change (e.g.
  // Setup -> Processing -> back to Setup after a failed generate) — a
  // component-local "already merged" set would reset on that remount and
  // re-merge every previously-completed upload a second time, silently
  // doubling the asset list.
  merged?: boolean;
}

export interface UploadRun {
  id: string;
  startedAt: string;
  items: UploadItem[];
}

// Uploading is I/O-bound (a multipart file write), not CPU-bound like the
// Twelve Labs analysis queue — this only governs how many files transfer
// to the server at once, not any analysis work.
const UPLOAD_CONCURRENCY = 4;

let runs: UploadRun[] = [];
const listeners = new Set<() => void>();
const notifiedRuns = new Set<string>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeMediaUploads(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMediaUploadsSnapshot(): UploadRun[] {
  return runs;
}

function checkRunComplete(runId: string): void {
  if (notifiedRuns.has(runId)) return;
  const run = runs.find((r) => r.id === runId);
  if (!run || run.items.length === 0) return;
  if (!run.items.every((it) => it.status === "done" || it.status === "failed")) return;
  notifiedRuns.add(runId);
  addNotification({
    kind: "upload",
    total: run.items.length,
    succeeded: run.items.filter((it) => it.status === "done").length,
    failed: run.items.filter((it) => it.status === "failed").length,
  });
}

function patchItem(runId: string, itemId: string, patch: Partial<UploadItem>): void {
  runs = runs.map((r) =>
    r.id !== runId ? r : { ...r, items: r.items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)) }
  );
  emit();
  checkRunComplete(runId);
}

export function totalPendingUploadCount(): number {
  return runs.reduce((sum, r) => sum + r.items.filter((it) => it.status === "uploading").length, 0);
}

export function totalUploadItemCount(): number {
  return runs.reduce((sum, r) => sum + r.items.length, 0);
}

/**
 * Kicks off concurrent per-file uploads and returns immediately — the
 * caller never awaits this, so selecting any number of files starts real
 * upload work with no confirm click and no blocking. Each file is its
 * own request (not one giant multipart POST of everything), so a slow
 * file can never hold up ones that finish transferring sooner.
 */
export function startMediaUpload(files: File[]): string {
  const runId = `upload_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const run: UploadRun = {
    id: runId,
    startedAt: new Date().toISOString(),
    items: files.map((f, i) => ({ id: `${runId}_${i}`, fileName: f.name, status: "uploading" as const })),
  };
  runs = [run, ...runs];
  emit();

  void mapWithConcurrency(files, UPLOAD_CONCURRENCY, async (file, i) => {
    const itemId = run.items[i].id;
    try {
      const [asset] = await uploadFiles([file]);
      patchItem(runId, itemId, { status: "done", asset });
    } catch (err) {
      patchItem(runId, itemId, { status: "failed", error: err instanceof Error ? err.message : "Upload failed." });
    }
  });

  return runId;
}

/** Completed uploads not yet folded into any project's asset list, oldest
 *  first — used by MediaPicker to merge newly-completed assets in as they
 *  arrive, including ones that finished while the picker wasn't mounted
 *  (e.g. the creator navigated away and back). Excludes already-merged
 *  items so a MediaPicker remount can never re-add the same asset twice
 *  — see `merged` on UploadItem. */
export function getUnmergedCompletedUploadAssets(): { itemId: string; asset: MediaAsset }[] {
  const out: { itemId: string; asset: MediaAsset }[] = [];
  for (const run of runs) {
    for (const it of run.items) {
      if (it.status === "done" && it.asset && !it.merged) out.push({ itemId: it.id, asset: it.asset });
    }
  }
  return out;
}

/** Marks completed uploads as folded into a project's asset list so they're
 *  never re-merged by a later MediaPicker mount. */
export function markUploadsMerged(itemIds: string[]): void {
  const ids = new Set(itemIds);
  if (ids.size === 0) return;
  runs = runs.map((r) => ({
    ...r,
    items: r.items.map((it) => (ids.has(it.id) ? { ...it, merged: true } : it)),
  }));
  emit();
}
