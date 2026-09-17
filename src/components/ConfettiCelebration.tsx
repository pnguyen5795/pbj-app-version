import type { CSSProperties } from "react";
import "./ConfettiCelebration.css";

const PIECE_COLORS = ["var(--pbj-accent)", "var(--pbj-accent-2)", "var(--pbj-border-strong)"];
const PIECE_COUNT = 18;

// Deterministic pseudo-random spread so pieces don't cluster — fine for a
// purely decorative, non-interactive celebration burst.
function pieceStyle(i: number): CSSProperties {
  const left = (i * 37) % 100;
  const delay = (i % 9) * 0.08;
  const duration = 1.6 + (i % 5) * 0.2;
  const rotate = (i * 53) % 360;
  const color = PIECE_COLORS[i % PIECE_COLORS.length];
  return {
    left: `${left}%`,
    animationDelay: `${delay}s`,
    animationDuration: `${duration}s`,
    background: color,
    transform: `rotate(${rotate}deg)`,
  };
}

/**
 * Light confetti rain — purely CSS-driven so it never needs manual
 * teardown. Mount with `show` once and leave it; it's inert (pointer
 * events off) once it finishes falling.
 */
export function ConfettiCelebration({ show }: { show: boolean }) {
  if (!show) return null;

  return (
    <div className="pbj-confetti" aria-hidden="true">
      {Array.from({ length: PIECE_COUNT }).map((_, i) => (
        <span key={i} className="pbj-confetti__piece" style={pieceStyle(i)} />
      ))}
    </div>
  );
}
