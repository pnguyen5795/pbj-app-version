import "./SandwichBuild.css";

/**
 * The Cooking screen's hero visual — a PB&J sandwich, one real-artwork
 * layer per element (bottom bread, peanut butter, jelly, top bread with
 * a bite). All four PNGs share one crop box (see public/sandwich/ and
 * the extraction notes in the task report), so simple inset:0 stacking
 * is enough to align them correctly — no per-layer offset math needed.
 *
 * STATIC ONLY for now — this renders the four layers already in their
 * final resting position. The build/land/squash animation described in
 * the task is a separate, not-yet-approved follow-up; do not add motion
 * here without that go-ahead.
 */
export function SandwichBuild() {
  return (
    <div className="pbj-sandwich-build" aria-hidden="true">
      <img src="/sandwich/bottom-bread.png" alt="" className="pbj-sandwich-build__layer" />
      <img src="/sandwich/peanut-butter.png" alt="" className="pbj-sandwich-build__layer" />
      <img src="/sandwich/jelly.png" alt="" className="pbj-sandwich-build__layer" />
      <img src="/sandwich/top-bread.png" alt="" className="pbj-sandwich-build__layer" />
    </div>
  );
}
