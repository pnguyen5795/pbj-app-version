import { useEffect } from "react";
import "./Splash.css";

const HAS_LAUNCHED_KEY = "pbj_has_launched";

function hasLaunchedBefore(): boolean {
  try {
    return localStorage.getItem(HAS_LAUNCHED_KEY) === "true";
  } catch {
    return false;
  }
}

function markLaunched(): void {
  try {
    localStorage.setItem(HAS_LAUNCHED_KEY, "true");
  } catch {
    // Best-effort — worst case every launch gets the longer splash.
  }
}

/** Full-screen, not tappable, no buttons. First launch holds ~1.5s (so the
 *  brand actually registers before Sign in); every launch after is a quick
 *  ~0.5s beat before Home — long enough to feel intentional, not a stall. */
export function Splash({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const durationMs = hasLaunchedBefore() ? 500 : 1500;
    const timer = setTimeout(() => {
      markLaunched();
      onDone();
    }, durationMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="pbj-splash" aria-hidden="true">
      <img src="/sandwich-logo.png" alt="" className="pbj-splash__mark" />
      <span className="pbj-splash__wordmark">pb&j</span>
    </div>
  );
}
