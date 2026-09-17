import { useEffect, useState, useSyncExternalStore } from "react";
import type { TrainingProject } from "../services/interfaces";
import { TopBar } from "../components/TopBar";
import { Button } from "../components/Button";
import { styleTrainingService } from "../services";
import { makeId } from "../utils/id";
import {
  startTrainingBatch,
  updateTrainingBatchProject,
  subscribeTrainingBatches,
  getTrainingBatchesSnapshot,
  type BatchRun,
  type BatchItemStatus,
  type BatchSubmissionInput,
} from "../state/trainingBatchStore";
import "./StyleTraining.css";

const STATUS_LABELS: Record<BatchItemStatus, string> = {
  uploading: "uploading",
  queued: "queued for analysis",
  analyzing: "analyzing",
  done: "done",
  failed: "failed",
};

/** A run stays in the "processing" section while anything in it still
 *  needs attention — in progress, failed, or awaiting review. Once every
 *  item has settled and been reviewed, it quietly drops out here; it's
 *  still permanently visible in "training history" below. */
function runNeedsAttention(run: BatchRun): boolean {
  return run.items.some((it) => {
    if (it.status !== "done") return true; // uploading/queued/analyzing/failed
    return it.project?.reviewStatus === "pending";
  });
}

function mergeProjects(fetched: TrainingProject[], fromStore: TrainingProject[]): TrainingProject[] {
  const byId = new Map(fetched.map((p) => [p.id, p]));
  for (const p of fromStore) byId.set(p.id, p); // store copies are the freshest
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function ReviewPanel({
  project,
  onUpdated,
}: {
  project: TrainingProject;
  onUpdated: (p: TrainingProject) => void;
}) {
  const diff = project.proposedDiff;
  const [selectedCuts, setSelectedCuts] = useState<Set<string>>(
    new Set(diff?.cutCategoryProposals.map((p) => p.id) ?? [])
  );
  const [selectedHolds, setSelectedHolds] = useState<Set<string>>(
    new Set(diff?.holdSignalProposals.map((p) => p.id) ?? [])
  );
  const [includeNotes, setIncludeNotes] = useState(true);
  const [busy, setBusy] = useState(false);

  if (!diff) return null;

  const hasProposals =
    diff.cutCategoryProposals.length > 0 || diff.holdSignalProposals.length > 0 || diff.noteProposals.length > 0;

  if (!hasProposals) {
    return <p className="pbj-training__empty-diff">Nothing rose to the level of a proposal from this submission.</p>;
  }

  function toggle(set: Set<string>, setSet: (s: Set<string>) => void, id: string) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSet(next);
  }

  async function approve() {
    setBusy(true);
    try {
      const updated = await styleTrainingService.review(project.id, "approve", {
        cutCategoryIds: [...selectedCuts],
        holdSignalIds: [...selectedHolds],
        includeNotes,
      });
      onUpdated(updated);
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      const updated = await styleTrainingService.review(project.id, "reject");
      onUpdated(updated);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pbj-training__review">
      {diff.conflicts.length > 0 && (
        <div className="pbj-training__conflicts">
          {diff.conflicts.map((c, i) => (
            <p key={i} className="pbj-training__conflict">
              ⚠ {c.description}
            </p>
          ))}
        </div>
      )}

      {diff.cutCategoryProposals.map((p) => (
        <label key={p.id} className="pbj-training__proposal">
          <input
            type="checkbox"
            checked={selectedCuts.has(p.id)}
            onChange={() => toggle(selectedCuts, setSelectedCuts, p.id)}
          />
          <div>
            <div className="pbj-training__proposal-title">
              new cut category: "{p.name}"
              {p.matchedExistingName && (
                <span className="pbj-training__proposal-hint"> (may extend "{p.matchedExistingName}")</span>
              )}
            </div>
            <div className="pbj-training__proposal-citation">{p.citation}</div>
          </div>
        </label>
      ))}

      {diff.holdSignalProposals.map((p) => (
        <label key={p.id} className="pbj-training__proposal">
          <input
            type="checkbox"
            checked={selectedHolds.has(p.id)}
            onChange={() => toggle(selectedHolds, setSelectedHolds, p.id)}
          />
          <div>
            <div className="pbj-training__proposal-title">new hold signal: {p.keywords.join(", ")}</div>
            <div className="pbj-training__proposal-citation">"{p.evidence[0]?.description}"</div>
          </div>
        </label>
      ))}

      {diff.noteProposals.length > 0 && (
        <label className="pbj-training__proposal">
          <input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} />
          <div>
            <div className="pbj-training__proposal-title">reference notes</div>
            {diff.noteProposals.map((n, i) => (
              <div key={i} className="pbj-training__proposal-citation">
                {n}
              </div>
            ))}
          </div>
        </label>
      )}

      <div className="pbj-training__review-actions">
        <Button variant="secondary" onClick={reject} disabled={busy}>
          reject
        </Button>
        <Button onClick={approve} disabled={busy}>
          {busy ? "saving…" : "approve selected"}
        </Button>
      </div>
    </div>
  );
}

/** Exactly two inputs — pick raw, pick the matching final, and the pair
 *  submits itself the instant both are present. Kept deliberately
 *  separate from the bulk dropzone below: a raw+final pair still needs a
 *  real human match (never guessed from filename or order — a wrong
 *  guess would corrupt the extracted patterns), but that decision is
 *  scoped to just these two files, so it never makes the common case
 *  (a pile of standalone finished edits) wait on anything.
 */
function PairComposer() {
  const [raw, setRaw] = useState<File | null>(null);
  const [final, setFinal] = useState<File | null>(null);

  function submitPair(rawFile: File, finalFile: File) {
    startTrainingBatch([
      { id: makeId("batch"), fileName: finalFile.name, type: "raw-plus-final", final: finalFile, raw: rawFile },
    ]);
    setRaw(null);
    setFinal(null);
  }

  function handleRawChange(file: File | null) {
    if (file && final) submitPair(file, final);
    else setRaw(file);
  }

  function handleFinalChange(file: File | null) {
    if (file && raw) submitPair(raw, file);
    else setFinal(file);
  }

  return (
    <div className="pbj-training__pair-composer">
      <p className="pbj-training__type-hint">
        Pairing compares what was kept, cut, and held longest — the highest-value submission. Pick both files and
        the pair submits itself immediately.
      </p>
      <div className="pbj-training__pair-slots">
        <label className="pbj-training__pair-slot">
          <input
            type="file"
            accept="video/*"
            className="pbj-training__file-input"
            onChange={(e) => handleRawChange(e.target.files?.[0] ?? null)}
          />
          <span className="pbj-training__batch-filename">{raw ? raw.name : "choose raw footage…"}</span>
        </label>
        <label className="pbj-training__pair-slot">
          <input
            type="file"
            accept="video/*"
            className="pbj-training__file-input"
            onChange={(e) => handleFinalChange(e.target.files?.[0] ?? null)}
          />
          <span className="pbj-training__batch-filename">{final ? final.name : "choose the matching finished edit…"}</span>
        </label>
      </div>
    </div>
  );
}

export function StyleTraining({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<TrainingProject[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Backed by a module-level store, not local state — a batch keeps
  // running (and stays visible here or via the app-wide badge) even if
  // this screen unmounts because the creator navigated away.
  const runs = useSyncExternalStore(subscribeTrainingBatches, getTrainingBatchesSnapshot);

  useEffect(() => {
    styleTrainingService.listProjects().then((list) => {
      setItems(list);
      setLoadingHistory(false);
    });
  }, []);

  // Every file dropped here defaults to (and stays) a standalone
  // finished-only submission and starts uploading the instant it's
  // added — no confirm click, no per-file interruption, no waiting for
  // the rest of the batch to be "ready" first. This is the common case
  // (a pile of finished edits for tone/pacing reference); raw+final
  // pairing lives in the separate composer above, which is the only
  // path that ever needs a deliberate match before submitting.
  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("video/"));
    if (files.length === 0) return;
    const inputs: BatchSubmissionInput[] = files.map((file) => ({
      id: makeId("batch"),
      fileName: file.name,
      type: "finished-only",
      final: file,
    }));
    startTrainingBatch(inputs);
  }

  function updateProject(updated: TrainingProject) {
    setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
    updateTrainingBatchProject(updated);
  }

  const visibleRuns = runs.filter(runNeedsAttention);
  const storeProjects = runs.flatMap((r) => r.items).map((it) => it.project).filter((p): p is TrainingProject => !!p);
  const historyItems = mergeProjects(items, storeProjects);

  return (
    <div className="pbj-training">
      <TopBar title="style training" onBack={onBack} />

      <div className="pbj-training__body">
        <p className="pbj-training__sub">
          Submit real finished edits (for tone/pacing reference) or raw-footage/finished-edit pairs (the
          highest-value comparison) to teach the AI more about your editing style. Every submission is reviewed
          here before it can change how your edits get made — nothing applies automatically.
        </p>

        <section className="pbj-training__card">
          <input
            type="file"
            accept="video/*"
            multiple
            className="pbj-training__file-input"
            id="pbj-training-dropzone-input"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <label
            htmlFor="pbj-training-dropzone-input"
            className={"pbj-training__dropzone" + (dragActive ? " pbj-training__dropzone--active" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
            }}
          >
            drop one or more finished edits here, or tap to choose — uploads start immediately
          </label>
        </section>

        <section className="pbj-training__card">
          <PairComposer />
        </section>

        {visibleRuns.length > 0 && (
          <section className="pbj-training__history">
            <h2 className="pbj-training__history-title">processing</h2>
            {visibleRuns.map((run) => (
              <div key={run.id} className="pbj-training__row-wrap">
                {run.items.map((it) => (
                  <div key={it.id} className="pbj-training__batch-row">
                    <span className="pbj-training__batch-filename" title={it.fileName}>
                      {it.fileName}
                    </span>
                    <span className={`pbj-training__batch-status pbj-training__batch-status--${it.status}`}>
                      {STATUS_LABELS[it.status]}
                    </span>
                    {it.status === "failed" && <p className="pbj-training__error">{it.error}</p>}
                    {it.status === "done" && it.project?.summary && (
                      <p className="pbj-training__summary">{it.project.summary}</p>
                    )}
                    {it.status === "done" && it.project?.reviewStatus === "pending" && (
                      <ReviewPanel project={it.project} onUpdated={updateProject} />
                    )}
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}

        <section className="pbj-training__history">
          <h2 className="pbj-training__history-title">training history</h2>
          {loadingHistory && <p className="pbj-training__hint">loading…</p>}
          {!loadingHistory && historyItems.length === 0 && (
            <p className="pbj-training__hint">No training submissions yet.</p>
          )}
          {historyItems.map((p) => (
            <div key={p.id} className="pbj-training__row-wrap">
              <button
                type="button"
                className="pbj-training__row"
                onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
              >
                <div className="pbj-training__row-main">
                  <span className="pbj-training__type-badge">
                    {p.type === "raw-plus-final" ? "raw + final" : "finished only"}
                  </span>
                  <span className="pbj-training__row-name">{p.finalFileName}</span>
                </div>
                <div className="pbj-training__row-meta">
                  <span className="pbj-training__date">{new Date(p.createdAt).toLocaleDateString()}</span>
                  <span className={`pbj-training__status pbj-training__status--${p.status}`}>{p.status}</span>
                  {p.reviewStatus !== "none" && (
                    <span className={`pbj-training__review-badge pbj-training__review-badge--${p.reviewStatus}`}>
                      {p.reviewStatus}
                    </span>
                  )}
                </div>
              </button>

              {expandedId === p.id && (
                <div className="pbj-training__detail">
                  {p.status === "failed" && <p className="pbj-training__error">{p.errorMessage}</p>}
                  {p.summary && <p className="pbj-training__summary">{p.summary}</p>}
                  {p.reviewStatus === "pending" && <ReviewPanel project={p} onUpdated={updateProject} />}
                </div>
              )}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
