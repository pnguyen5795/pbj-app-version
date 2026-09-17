import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { BackButton } from "../components/BackButton";
import { SandwichBuild } from "../components/SandwichBuild";
import { useRenderProgress } from "../hooks/useRenderProgress";
import type { ActiveRender } from "../state/useAppFlow";
import { COOKING_NARRATION, FAKE_ETA_MINUTES } from "../data/placeholders";
import "./Cooking.css";

const PUSH_PROMPT_SEEN_KEY = "pbj_seen_push_prompt";
const ACTION_ROTATE_MS = 3000;
const ACTION_FADE_MS = 200;

function hasSeenPushPrompt(): boolean {
  try {
    return localStorage.getItem(PUSH_PROMPT_SEEN_KEY) === "true";
  } catch {
    return false;
  }
}

function markPushPromptSeen(): void {
  try {
    localStorage.setItem(PUSH_PROMPT_SEEN_KEY, "true");
  } catch {
    // Best-effort.
  }
}

/** Smoothly chases `target` via a continuous exponential approach
 *  (recomputed every animation frame) rather than a discrete tween —
 *  target updates every 100ms from useRenderProgress, and re-triggering a
 *  fixed-duration ease on every one of those ticks would mean the
 *  animation never actually settles. Chasing the live value instead
 *  reads as one continuous smooth climb regardless of how often the
 *  target moves. */
function useSmoothedValue(target: number, rate = 0.12): number {
  const [value, setValue] = useState(target);
  const valueRef = useRef(target);
  useEffect(() => {
    let raf: number;
    function tick() {
      const current = valueRef.current;
      const diff = target - current;
      const next = Math.abs(diff) < 0.05 ? target : current + diff * rate;
      valueRef.current = next;
      setValue(next);
      if (next !== target) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, rate]);
  return value;
}

export function Cooking({
  render,
  onBack,
  onCancel,
  onEdit,
  onComplete,
}: {
  render: ActiveRender;
  /** Leaves for Home with the render continuing in the background —
   *  non-destructive, the whole point of this screen no longer being a
   *  dead end. */
  onBack: () => void;
  /** Confirmed-destructive: render is gone, back to Home. */
  onCancel: () => void;
  /** Confirmed-destructive: render is gone, back to the Recipe screen. */
  onEdit: () => void;
  onComplete: () => void;
}) {
  const progress = useRenderProgress(render);
  const displayedProgress = useSmoothedValue(progress);
  const [actionIndex, setActionIndex] = useState(0);
  const [actionFading, setActionFading] = useState(false);
  // Which control opened the shared confirm sheet — both Cancel and Edit
  // Recipe are destructive to the in-flight render (see the task's own
  // framing) and share one sheet; this just tracks which action to run
  // if the creator confirms.
  const [confirmAction, setConfirmAction] = useState<"cancel" | "edit" | null>(null);
  const [showPushPrompt] = useState(() => !hasSeenPushPrompt());
  const [pinged, setPinged] = useState(false);
  const completeRef = useRef(onComplete);
  useEffect(() => {
    completeRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    const id = setInterval(() => {
      setActionFading(true);
      setTimeout(() => {
        setActionIndex((i) => (i + 1) % COOKING_NARRATION.length);
        setActionFading(false);
      }, ACTION_FADE_MS);
    }, ACTION_ROTATE_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // Guarded on confirmAction too: reaching 100% while the creator is
    // mid-decision on a confirm sheet must never silently yank them into
    // Studio out from under it. If they dismiss the dialog ("keep
    // cooking") after this point, this effect re-runs and completes
    // normally.
    if (progress >= 100 && confirmAction === null) {
      const timer = setTimeout(() => completeRef.current(), 600);
      return () => clearTimeout(timer);
    }
  }, [progress, confirmAction]);

  useEffect(() => {
    markPushPromptSeen();
  }, []);

  const remainingMinutes = Math.ceil(FAKE_ETA_MINUTES * (1 - progress / 100));
  const etaText = progress === 0 ? "Estimating…" : remainingMinutes <= 0 ? "Order coming up" : `~${remainingMinutes} min left`;

  return (
    <div className="pbj-cooking">
      <BackButton onClick={onBack} className="pbj-back-btn--floating" />

      <div className="pbj-cooking__body">
        <SandwichBuild />

        <div className="pbj-cooking__status">
          <p className="pbj-cooking__eta">{etaText}</p>
          <p className="pbj-cooking__percent">{Math.round(displayedProgress)}% done</p>
          <p className={"pbj-cooking__action" + (actionFading ? " pbj-cooking__action--fading" : "")}>
            {COOKING_NARRATION[actionIndex]}
          </p>
          {/* The reassurance nudge — always visible, not conditional, not
              buried. Separate from the interactive "Ping Me When It's
              Done" block below (still opt-in, first-run-only): this is
              passive permission-to-leave text, that's a notification
              opt-in action. Flagged in the task report as a judgment
              call — the two read a little redundant on a first-ever
              visit, when both are on screen at once. */}
          <p className="pbj-cooking__nudge">Feel free to leave — we'll notify you when it's ready.</p>
        </div>
      </div>

      {/* Pinned to the true bottom. Edit Recipe (quiet, grey) sits above
          Cancel (quietest, grey) — both small text buttons, both destructive
          to the in-flight render, sharing the confirm sheet below. See the
          task report for whether these two should collapse into one. */}
      <div className="pbj-cooking__bottom-actions">
        <Button
          type="button"
          variant="text"
          onClick={() => setConfirmAction("edit")}
          className="pbj-cooking__edit-btn"
        >
          Edit Recipe
        </Button>
        <Button
          type="button"
          variant="text"
          onClick={() => setConfirmAction("cancel")}
          className="pbj-cooking__cancel-btn"
        >
          Cancel
        </Button>
      </div>

      {showPushPrompt && confirmAction === null && (
        <div className="pbj-cooking__push">
          <p className="pbj-cooking__push-benefit">We'll Ping You the Second Your Edit's Ready</p>
          {pinged ? (
            <p className="pbj-cooking__push-confirmed">You're Set — We'll Ping You</p>
          ) : (
            <Button type="button" fullWidth onClick={() => setPinged(true)}>
              Ping Me When It's Done
            </Button>
          )}
        </div>
      )}

      {confirmAction !== null && (
        <div className="pbj-cooking__confirm-backdrop" onClick={() => setConfirmAction(null)}>
          <div className="pbj-cooking__confirm" onClick={(e) => e.stopPropagation()}>
            <span className="pbj-cooking__confirm-grabber" aria-hidden="true" />
            <p className="pbj-cooking__confirm-text">Cancel Now and This Render Is Gone — You'll Have to Start Over</p>
            <Button type="button" fullWidth onClick={() => setConfirmAction(null)}>
              Keep Cooking
            </Button>
            <Button
              type="button"
              variant="text"
              fullWidth
              onClick={confirmAction === "edit" ? onEdit : onCancel}
              className="pbj-cooking__confirm-danger-text"
            >
              Cancel Anyway
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
