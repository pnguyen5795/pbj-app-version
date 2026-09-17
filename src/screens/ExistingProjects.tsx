import { useEffect, useState } from "react";
import { BackButton } from "../components/BackButton";
import { Button } from "../components/Button";
import { Placeholder } from "../components/Placeholder";
import type { FakeProject } from "../data/placeholders";
import "./ExistingProjects.css";

const DELETE_TOAST_MS = 2200;

export function ExistingProjects({
  projects,
  onBack,
  onOpenProject,
  onRenameProject,
  onDeleteProject,
}: {
  projects: FakeProject[];
  onBack: () => void;
  onOpenProject: (id: string) => void;
  onRenameProject: (id: string, title: string) => void;
  onDeleteProject: (id: string) => void;
}) {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingProject, setDeletingProject] = useState<FakeProject | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function startRename(p: FakeProject) {
    setMenuOpenId(null);
    setRenamingId(p.id);
    setRenameValue(p.title);
  }

  function confirmRename() {
    if (!renamingId) return;
    const current = projects.find((p) => p.id === renamingId);
    onRenameProject(renamingId, renameValue.trim() || current?.title || "");
    setRenamingId(null);
  }

  function askDelete(p: FakeProject) {
    setMenuOpenId(null);
    setDeletingProject(p);
  }

  function cancelDelete() {
    setDeletingProject(null);
  }

  function confirmDelete() {
    if (!deletingProject) return;
    onDeleteProject(deletingProject.id);
    setDeletingProject(null);
    setToast("Project Deleted.");
    setTimeout(() => setToast(null), DELETE_TOAST_MS);
  }

  // Backdrop tap and Escape both cancel — never delete.
  useEffect(() => {
    if (!deletingProject) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") cancelDelete();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deletingProject]);

  return (
    <div className="pbj-projects" onClick={() => setMenuOpenId(null)}>
      <BackButton onClick={onBack} className="pbj-back-btn--floating" />

      <div className="pbj-projects__body">
        <h1 className="pbj-projects__title">My Projects</h1>

        {projects.length === 0 ? (
          <div className="pbj-projects__empty">
            <p className="pbj-projects__empty-title">No Projects Yet</p>
            <p className="pbj-projects__empty-sub">Start One From the Home Screen</p>
          </div>
        ) : (
          <div className="pbj-projects__grid">
            {projects.map((p) => (
              <Placeholder key={p.id} className="pbj-projects__tile-wrap">
                <div className="pbj-projects__tile">
                  <button
                    type="button"
                    className="pbj-projects__thumb"
                    style={{ background: p.thumbGradient }}
                    onClick={() => onOpenProject(p.id)}
                  >
                    {/* iOS unread convention (Mail, Photos) — clears on
                        actual playback in Studio, not on merely opening
                        this row; see Studio's onFirstPlay. */}
                    {p.unread && <span className="pbj-projects__unread-dot" aria-label="Unread" />}
                    <span className="pbj-projects__duration">{p.durationLabel}</span>
                  </button>
                  <div className="pbj-projects__meta">
                    {renamingId === p.id ? (
                      <input
                        autoFocus
                        className="pbj-projects__rename-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={confirmRename}
                        onKeyDown={(e) => e.key === "Enter" && confirmRename()}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="pbj-projects__name">{p.title}</span>
                    )}
                    <button
                      type="button"
                      className="pbj-projects__menu-btn"
                      aria-label="Project options"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenId(menuOpenId === p.id ? null : p.id);
                      }}
                    >
                      ⋯
                    </button>
                  </div>

                  {menuOpenId === p.id && (
                    <div className="pbj-projects__menu" onClick={(e) => e.stopPropagation()}>
                      <button type="button" onClick={() => startRename(p)}>
                        Rename
                      </button>
                      <button
                        type="button"
                        className="pbj-projects__menu-delete"
                        onClick={() => askDelete(p)}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </Placeholder>
            ))}
          </div>
        )}
      </div>

      {toast && <p className="pbj-projects__toast">{toast}</p>}

      {deletingProject && (
        <div className="pbj-projects__delete-backdrop" onClick={cancelDelete}>
          <div
            className="pbj-projects__delete-modal"
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="pbj-delete-title"
          >
            <h2 id="pbj-delete-title" className="pbj-projects__delete-title">
              Delete This Project?
            </h2>
            <p className="pbj-projects__delete-body">
              {deletingProject.title} Will Be Permanently Deleted. This Can't Be Undone.
            </p>
            {/* Cancel is the safe default and takes focus on open; Delete
                never does — it's the quiet, deliberate-tap option, same
                hierarchy as the corrected Cooking cancel dialog. */}
            <Button fullWidth autoFocus onClick={cancelDelete}>
              Cancel
            </Button>
            <Button
              variant="text"
              fullWidth
              onClick={confirmDelete}
              className="pbj-projects__delete-confirm-btn"
            >
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
