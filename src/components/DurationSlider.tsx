import { formatDuration } from "../utils/format";
import "./DurationSlider.css";

interface DurationSliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}

export function DurationSlider({
  value,
  min = 0,
  max = 600,
  step = 5,
  onChange,
}: DurationSliderProps) {
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className="pbj-duration">
      <span className="pbj-duration__value">{formatDuration(value)}</span>

      <input
        type="range"
        className="pbj-duration__slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ["--pbj-slider-pct" as string]: `${pct}%` }}
        aria-label="Target video duration"
      />
    </div>
  );
}
