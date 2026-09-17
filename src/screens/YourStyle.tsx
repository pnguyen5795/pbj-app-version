import { useState } from "react";
import { Button } from "../components/Button";
import "./YourStyle.css";

const CHIP_OPTIONS = [
  "fitness",
  "food",
  "lifestyle",
  "gaming",
  "music",
  "travel",
  "comedy",
  "beauty",
  "sports",
  "vlog",
  "business",
  "pets",
];

// Display-only — one distinct emoji per category, keyed off the same values
// used for app state. The category strings themselves (CHIP_OPTIONS) never
// carry the emoji; onDone(selected) still returns plain names like "fitness".
const CHIP_EMOJI: Record<string, string> = {
  fitness: "💪",
  food: "🍔",
  lifestyle: "🌿",
  gaming: "🎮",
  music: "🎵",
  travel: "✈️",
  comedy: "😂",
  beauty: "💄",
  sports: "🏀",
  vlog: "🎥",
  business: "💼",
  pets: "🐾",
};

const MAX_SELECTED = 3;

export function YourStyle({ onDone }: { onDone: (selected: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([]);

  function toggle(chip: string) {
    setSelected((prev) => {
      if (prev.includes(chip)) return prev.filter((c) => c !== chip);
      if (prev.length >= MAX_SELECTED) return prev;
      return [...prev, chip];
    });
  }

  return (
    <div className="pbj-your-style">
      <div className="pbj-your-style__body">
        <div className="pbj-your-style__hero">
          <h1 className="pbj-your-style__title">What's Your Style</h1>
          <p className="pbj-your-style__sub">Just So We Know Where to Start</p>
        </div>

        <div className="pbj-your-style__grid">
          {CHIP_OPTIONS.map((chip) => {
            const isSelected = selected.includes(chip);
            const isDisabled = !isSelected && selected.length >= MAX_SELECTED;
            return (
              <button
                key={chip}
                type="button"
                className={
                  "pbj-your-style__chip" +
                  (isSelected ? " pbj-your-style__chip--selected" : "") +
                  (isDisabled ? " pbj-your-style__chip--disabled" : "")
                }
                onClick={() => toggle(chip)}
                disabled={isDisabled}
              >
                <span className="pbj-your-style__chip-emoji" aria-hidden="true">
                  {CHIP_EMOJI[chip]}
                </span>
                {/* CHIP_OPTIONS stays lowercase (it's the actual state
                    value onDone returns, and the CHIP_EMOJI lookup key) —
                    capitalized only here, at render, so the display text
                    reads as title case without changing that identifier. */}
                <span>{chip.charAt(0).toUpperCase() + chip.slice(1)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="pbj-your-style__footer">
        <Button fullWidth disabled={selected.length === 0} onClick={() => onDone(selected)}>
          Continue
        </Button>
        <Button variant="text" fullWidth onClick={() => onDone([])}>
          Skip
        </Button>
      </div>
    </div>
  );
}
