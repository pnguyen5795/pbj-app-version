import { useEffect, useRef, useState } from "react";
import { BackButton } from "../components/BackButton";
import { Button } from "../components/Button";
import { Placeholder } from "../components/Placeholder";
import { TEACH_IT_OBSERVATIONS, GENERATED_STYLE_NAME } from "../data/placeholders";
import "./TeachIt.css";

type TeachState = "ask" | "analyzing" | "styleCard";

const OBSERVATION_HOLD_MS = 1400;
const STYLE_CARD_HOLD_MS = 2200;

/**
 * One screen, three sequential states, no navigation/extra tap between
 * them — analyzing and the style card are driven entirely by timers here,
 * not by any real analysis (that's Paul's backend work later).
 */
export function TeachIt({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [state, setState] = useState<TeachState>("ask");
  const [observationIndex, setObservationIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  function chooseVideo(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setState("analyzing");
  }

  // State B: cycle through fake observations one at a time, then move to
  // the style card once they've all shown.
  useEffect(() => {
    if (state !== "analyzing") return;
    if (observationIndex >= TEACH_IT_OBSERVATIONS.length - 1) {
      const toCard = setTimeout(() => setState("styleCard"), OBSERVATION_HOLD_MS);
      return () => clearTimeout(toCard);
    }
    const next = setTimeout(() => setObservationIndex((i) => i + 1), OBSERVATION_HOLD_MS);
    return () => clearTimeout(next);
  }, [state, observationIndex]);

  // State C: hold the style card, then auto-advance to Home.
  useEffect(() => {
    if (state !== "styleCard") return;
    const timer = setTimeout(() => doneRef.current(), STYLE_CARD_HOLD_MS);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <div className="pbj-teach-it">
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="pbj-teach-it__file-input"
        onChange={(e) => chooseVideo(e.target.files)}
      />

      {state === "ask" && (
        <>
          <div className="pbj-teach-it__ask">
            <BackButton onClick={onBack} className="pbj-back-btn--floating" />

            <div className="pbj-teach-it__ask-hero">
              <h1 className="pbj-teach-it__title">Teach Us Your Style</h1>
              <p className="pbj-teach-it__sub">
                Upload One Video and Every Edit After This Sounds Like You
              </p>
            </div>

            {/* Fills the remaining space down to the footer and centers the
                tile in it both ways — the tile is the focal point of the
                screen, not tucked under the subhead. */}
            <div className="pbj-teach-it__dropzone-wrap">
              <button
                type="button"
                className="pbj-teach-it__dropzone"
                onClick={() => fileInputRef.current?.click()}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="5" width="18" height="15" rx="3" stroke="currentColor" strokeWidth="1.6" />
                  <circle cx="8.5" cy="10.5" r="1.5" fill="currentColor" />
                  <path
                    d="M4 17l4.5-4.5a2 2 0 0 1 2.8 0L16 17M14.5 15.5l1.2-1.2a2 2 0 0 1 2.8 0L21 17"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>Tap to Choose From Your Camera Roll</span>
              </button>
            </div>
          </div>

          <div className="pbj-teach-it__footer">
            <Button variant="text" fullWidth onClick={onDone}>
              Start From Scratch Instead
            </Button>
          </div>
        </>
      )}

      {state === "analyzing" && (
        <div className="pbj-teach-it__analyzing">
          <div className="pbj-teach-it__blob" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <Placeholder key={observationIndex} className="pbj-teach-it__observation">
            {TEACH_IT_OBSERVATIONS[observationIndex]}
          </Placeholder>
        </div>
      )}

      {state === "styleCard" && (
        <div className="pbj-teach-it__card-wrap">
          <Placeholder className="pbj-teach-it__card">
            <span className="pbj-teach-it__card-label">Here's Your Style</span>
            <span className="pbj-teach-it__card-name">{GENERATED_STYLE_NAME}</span>
          </Placeholder>
        </div>
      )}
    </div>
  );
}
