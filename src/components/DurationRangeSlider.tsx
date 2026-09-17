import { useRef } from "react";
import { formatDurationVerbose } from "../utils/format";
import "./DurationRangeSlider.css";

// Full replacement for the old vertical drum-roll picker (DurationWheel,
// deleted) — a single horizontal iOS-style slider instead. Range/step
// match the new spec exactly; any other consumer that assumed the old
// picker's 0-300s/10s-step range only ever read the resulting durationSec
// value (never these constants directly — confirmed via grep before this
// change), so nothing else needed updating for the new range.
export const DURATION_MIN_SEC = 5;
export const DURATION_MAX_SEC = 300;
export const DURATION_STEP_SEC = 5;
export const DURATION_DEFAULT_SEC = 60;

function fireStepHaptic() {
  try {
    navigator.vibrate?.(10);
  } catch {
    // Best-effort — silently no-ops on platforms without the Vibration API.
  }
}

export function DurationRangeSlider({
  valueSec,
  onChange,
}: {
  valueSec: number;
  onChange: (sec: number) => void;
}) {
  const lastValueRef = useRef(valueSec);
  const pct = ((valueSec - DURATION_MIN_SEC) / (DURATION_MAX_SEC - DURATION_MIN_SEC)) * 100;

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    const next = Number(e.target.value);
    if (next !== lastValueRef.current) {
      lastValueRef.current = next;
      fireStepHaptic();
    }
    onChange(next);
  }

  return (
    <div className="pbj-duration-slider">
      <span className="pbj-duration-slider__label">How Long?</span>
      <span className="pbj-duration-slider__value">{formatDurationVerbose(valueSec)}</span>
      <input
        type="range"
        className="pbj-duration-slider__track"
        min={DURATION_MIN_SEC}
        max={DURATION_MAX_SEC}
        step={DURATION_STEP_SEC}
        value={valueSec}
        onChange={handleInput}
        style={{ ["--pbj-slider-pct" as string]: `${pct}%` }}
        aria-label="Output duration"
        aria-valuetext={formatDurationVerbose(valueSec)}
      />
    </div>
  );
}
