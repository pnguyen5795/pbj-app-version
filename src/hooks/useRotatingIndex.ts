import { useEffect, useState } from "react";

/** Cycles 0..length-1 on its own interval — the plain version of the
 *  rotating-narration behavior Cooking.tsx builds with an extra fade
 *  transition layered on top. Used where a compact context (a Home row)
 *  wants the same rotating text without that extra chrome. */
export function useRotatingIndex(length: number, intervalMs: number): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (length <= 1) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % length), intervalMs);
    return () => clearInterval(id);
  }, [length, intervalMs]);
  return index % Math.max(1, length);
}
