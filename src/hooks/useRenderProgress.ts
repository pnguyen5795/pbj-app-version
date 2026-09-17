import { useEffect, useState } from "react";
import type { ActiveRender } from "../state/useAppFlow";

function computeProgress(render: ActiveRender): number {
  const pct = ((Date.now() - render.startedAt) / render.durationMs) * 100;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/** Derives live 0-100 progress from a render's own `startedAt` timestamp
 *  rather than a locally-owned ticking counter — the timestamp lives in
 *  shared app-flow state, so any number of components (a Home row, the
 *  full Cooking screen) can mount, unmount, and remount independently and
 *  each still land on the same correct value, with no cross-component
 *  sync needed. This is what lets a render survive navigating away from
 *  Cooking instead of resetting or freezing. */
export function useRenderProgress(render: ActiveRender): number {
  const [progress, setProgress] = useState(() => computeProgress(render));
  useEffect(() => {
    const id = setInterval(() => setProgress(computeProgress(render)), 100);
    return () => clearInterval(id);
  }, [render]);
  return progress;
}
