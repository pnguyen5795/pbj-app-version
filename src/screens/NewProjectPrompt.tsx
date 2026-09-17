import { useLayoutEffect, useRef, useState } from "react";
import { BackButton } from "../components/BackButton";
import { Button } from "../components/Button";
import { TRAINED_STYLES, PROMPT_PLACEHOLDER } from "../data/placeholders";
import "./NewProjectPrompt.css";

const MAX_STYLES = 3;
// Matches .pbj-np2__ingredient-row's own transition duration — the exit
// animation must finish playing before the row actually leaves styleIds,
// or it'd just vanish instantly instead of fading/collapsing out.
const REMOVE_ANIM_MS = 200;

function RemoveGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="rgba(120, 120, 128, 0.16)" />
      <path
        d="M8.5 8.5l7 7M15.5 8.5l-7 7"
        stroke="rgba(60, 60, 67, 0.6)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Sized for the small inset button (36px) — was 26px for the old 68px
// standalone button; scaled down proportionally to ~18px.
function MicGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" fill="currentColor" />
      <path d="M19 11a7 7 0 0 1-14 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// Doubled from the previous 128px cap per this pass's explicit ask —
// measured before/after in the task report. min-height (see the CSS) is
// doubled the same way, from its old 3-line formula value (~117.5px) to
// ~235px. The old "keep this deliberately tight" budget problem (noted
// here previously) is gone along with the mic/caption footer cluster
// this pass also removed — the footer is just the CTA now, so there's
// real room for a taller field without risking pushing it off screen.
const PROMPT_MAX_HEIGHT_PX = 256;

/**
 * New Project, screen 2 of 2 — "The Recipe". Prompt is the hero (a real
 * field now, not bare text), styles the user adds show up as an
 * ingredients list, and both stay fully independent state — adding a
 * style never writes into the prompt text, by design (see the task's
 * "metaphor discipline" — the kitchen language stays on nouns only).
 */
export function NewProjectPrompt({
  styleIds,
  onStyleIdsChange,
  prompt,
  onPromptChange,
  onBack,
  onSubmit,
}: {
  styleIds: string[];
  onStyleIdsChange: (ids: string[]) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isRecording, setIsRecording] = useState(false);
  // Ids currently mid-exit-animation — still rendered (with the
  // `--removing` class driving the fade/collapse transition) but already
  // gone from `styleIds` is wrong and gone-from-rendering is wrong too;
  // this is the "still visible, on its way out" middle state.
  const [removingIds, setRemovingIds] = useState<string[]>([]);

  function addStyle(id: string) {
    if (styleIds.length < MAX_STYLES) {
      onStyleIdsChange([...styleIds, id]);
    }
  }

  function removeStyle(id: string) {
    if (removingIds.includes(id)) return;
    setRemovingIds((prev) => [...prev, id]);
    setTimeout(() => {
      onStyleIdsChange(styleIds.filter((s) => s !== id));
      setRemovingIds((prev) => prev.filter((r) => r !== id));
    }, REMOVE_ANIM_MS);
  }

  const capReached = styleIds.length >= MAX_STYLES;
  // Original six-item order is TRAINED_STYLES' own order — filtering it
  // (rather than re-deriving order from styleIds some other way) is what
  // makes a removed style reappear in its original chip-row position for
  // free, with no extra bookkeeping.
  const availableStyles = TRAINED_STYLES.filter((s) => !styleIds.includes(s.id));

  // Auto-grow: height tracks content exactly up to PROMPT_MAX_HEIGHT_PX,
  // then scrolls internally — everything below (ingredients, chips,
  // footer) shifts down in normal flow instead. The mic no longer moves
  // with this (it's pinned to the field's own bottom-trailing corner via
  // CSS, not part of this flow). Re-measures on every keystroke and once
  // on mount (covers a prompt seeded from back-nav).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, PROMPT_MAX_HEIGHT_PX)}px`;
  }, [prompt]);

  function tapMic() {
    setIsRecording((r) => !r);
    // TODO(voice input): stub only — no real speech recognition wired yet.
    // See the task report for the Web Speech API / iOS Safari viability
    // writeup; this just toggles the visual state.
  }

  return (
    <div className="pbj-np2">
      <BackButton onClick={onBack} className="pbj-back-btn--floating" />

      <div className="pbj-np2__body">
        <div className="pbj-np2__hero">
          <h1 className="pbj-np2__title">The Recipe</h1>
          <p className="pbj-np2__subtitle">tell us how you want it cut</p>
        </div>

        {/* Mic lives inset inside the field itself now (bottom-trailing
            corner, 12px inset) rather than as its own standalone button
            below — see the wrapper's CSS for the positioning judgment
            call flagged in the task report. Still a stubbed TODO, not
            wired to anything real (see tapMic). */}
        <div className="pbj-np2__prompt-wrap">
          <textarea
            ref={textareaRef}
            className="pbj-np2__prompt"
            placeholder={PROMPT_PLACEHOLDER}
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            onFocus={(e) => e.currentTarget.scrollIntoView({ block: "center", behavior: "smooth" })}
            rows={1}
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
          />
          <button
            type="button"
            className={"pbj-np2__mic" + (isRecording ? " pbj-np2__mic--active" : "")}
            onClick={tapMic}
            aria-pressed={isRecording}
            aria-label={isRecording ? "Stop voice input" : "Start voice input"}
          >
            {isRecording && (
              <>
                <span className="pbj-np2__mic-ring" aria-hidden="true" />
                <span className="pbj-np2__mic-ring pbj-np2__mic-ring--delay" aria-hidden="true" />
              </>
            )}
            <MicGlyph />
          </button>
        </div>

        {/* Doesn't exist in the DOM at all with zero ingredients — no
            empty container, no placeholder copy (see the task spec). */}
        {styleIds.length > 0 && (
          <div className="pbj-np2__ingredients">
            {styleIds.map((id) => {
              const style = TRAINED_STYLES.find((s) => s.id === id);
              if (!style) return null;
              const isRemoving = removingIds.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  className={"pbj-np2__ingredient" + (isRemoving ? " pbj-np2__ingredient--removing" : "")}
                  onClick={() => removeStyle(id)}
                  disabled={isRemoving}
                  aria-label={`Remove ${style.label}`}
                >
                  <span className="pbj-np2__ingredient-text">
                    <span className="pbj-np2__ingredient-name">{style.label}</span>
                    <span className="pbj-np2__ingredient-phrase">{style.phrase}</span>
                  </span>
                  <RemoveGlyph />
                </button>
              );
            })}
          </div>
        )}

        <div className="pbj-np2__chips-section">
          <div className="pbj-np2__chips-row">
            {availableStyles.map((style) => (
              <button
                key={style.id}
                type="button"
                className={"pbj-np2__chip" + (capReached ? " pbj-np2__chip--muted" : "")}
                disabled={capReached}
                onClick={() => addStyle(style.id)}
              >
                {style.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Just the CTA now — mic moved into the recipe field itself (see
          above), "or start from"/"or say it out loud" both deleted per
          spec. Body's own flex:1 (top-anchored) still collects whatever
          slack is left as one gap right here, before the button. */}
      <div className="pbj-np2__footer">
        <Button className="pbj-np2__cta" fullWidth onClick={onSubmit} disabled={styleIds.length === 0}>
          let's cook!
        </Button>
      </div>
    </div>
  );
}
