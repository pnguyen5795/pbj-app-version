import type { ProcessingStep } from "../services/interfaces";
import "./Processing.css";

const STEP_LABEL: Record<ProcessingStep, string> = {
  uploading: "uploading your media",
  understanding: "analyzing your clips",
  style: "studying the reference style",
  planning: "building your edit plan",
  rendering: "rendering your video",
  done: "wrapping up",
};

const STEP_ORDER: ProcessingStep[] = [
  "uploading",
  "understanding",
  "style",
  "planning",
  "rendering",
];

export function Processing({ step }: { step: ProcessingStep | null }) {
  const activeIndex = step ? STEP_ORDER.indexOf(step) : 0;
  const isDone = step === "done";
  const pct = isDone
    ? 100
    : Math.round(((activeIndex + 0.5) / STEP_ORDER.length) * 100);

  return (
    <div className="pbj-processing">
      <div className="pbj-processing__spacer" />

      <div className="pbj-processing__center">
        <div className="pbj-processing__mark-wrap" aria-hidden="true">
          <span className="pbj-processing__float pbj-processing__float--a">🎬</span>
          <span className="pbj-processing__float pbj-processing__float--b">✨</span>
          <div className="pbj-processing__mark-glow" />
          <img src="/sandwich-logo.png" alt="" className="pbj-processing__mark" />
          <svg className="pbj-processing__ring" width="128" height="128" viewBox="0 0 128 128">
            <circle
              cx="64"
              cy="64"
              r="60"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="90 282"
            />
          </svg>
        </div>

        <h1 className="pbj-processing__title">request received</h1>
        <p className="pbj-processing__subtitle">
          we're putting your edit together
        </p>

        <div className="pbj-processing__progress">
          <div className="pbj-processing__progress-head">
            <span>{STEP_LABEL[step ?? "uploading"]}</span>
            <span className="pbj-processing__progress-pct">{pct}%</span>
          </div>
          <div className="pbj-processing__bar">
            <div className="pbj-processing__bar-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>

        <div className="pbj-processing__reassure">
          <span className="pbj-processing__reassure-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M18 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zM8 3v4M16 3v4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M12 20v1M12 3v1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
          <div>
            <p className="pbj-processing__reassure-title">feel free to leave the app</p>
            <p className="pbj-processing__reassure-sub">
              <span className="pbj-processing__live-dot" />
              this keeps working in the background — we'll notify you the moment your edit is ready
            </p>
          </div>
        </div>

        <ul className="pbj-processing__steps">
          {STEP_ORDER.map((s, i) => (
            <li
              key={s}
              className={
                "pbj-processing__step" +
                (i < activeIndex ? " pbj-processing__step--done" : "") +
                (i === activeIndex ? " pbj-processing__step--active" : "")
              }
            >
              <span className="pbj-processing__step-dot" />
              {STEP_LABEL[s]}
            </li>
          ))}
        </ul>
      </div>

      <div className="pbj-processing__spacer" />
    </div>
  );
}
