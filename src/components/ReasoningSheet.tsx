import type { EditPlan } from "../types";
import { Button } from "./Button";
import "../components/ExportSheet.css";
import "./ReasoningSheet.css";

interface ReasoningSheetProps {
  open: boolean;
  onClose: () => void;
  plan: EditPlan;
}

/**
 * Surfaces the "Play" reasoning PatternEditPlanService already generates —
 * why each clip was kept/cut, why one moment was held longest — plus any
 * warnings (e.g. clips Twelve Labs couldn't analyze, or the target
 * duration not being fully reachable from the available footage). Before
 * this component existed, `plan.editorialNotes` and `plan.warnings` were
 * computed correctly but never shown anywhere in the app.
 */
export function ReasoningSheet({ open, onClose, plan }: ReasoningSheetProps) {
  if (!open) return null;

  const notes = plan.editorialNotes ?? [];
  const warnings = plan.warnings ?? [];

  return (
    <div className="pbj-sheet-backdrop" onClick={onClose}>
      <div className="pbj-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="pbj-sheet__handle" />
        <h2 className="pbj-sheet__title">why this edit</h2>
        <p className="pbj-sheet__subtitle">the reasoning behind each keep/cut/hold decision</p>

        {warnings.length > 0 && (
          <ul className="pbj-reasoning__warnings">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}

        {notes.length > 0 ? (
          <ul className="pbj-reasoning__notes">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : (
          <p className="pbj-reasoning__empty">No reasoning available for this plan.</p>
        )}

        <Button fullWidth variant="secondary" onClick={onClose}>
          close
        </Button>
      </div>
    </div>
  );
}
