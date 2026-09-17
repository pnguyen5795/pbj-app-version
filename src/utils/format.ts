/** Formats seconds as a compact duration label, scaling with magnitude:
 *  0-59s -> "45s", exact minutes -> "5m", otherwise -> "2m 30s". */
export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (rem === 0) return `${min}m`;
  return `${min}m ${rem}s`;
}

/** Formats seconds fully worded, e.g. "4 min 10 sec", "50 sec", "1 min" —
 *  used wherever precision needs to stay readable at a glance (the New
 *  Project duration slider's value text). Moved here from the old
 *  DurationWheel component when that was replaced by the slider; this is
 *  still the one place this format is implemented. */
export function formatDurationVerbose(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s} sec`;
  if (s === 0) return `${m} min`;
  return `${m} min ${s} sec`;
}

/** Formats seconds as a player-style timestamp, e.g. "1:05". */
export function formatTimestamp(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Same as formatTimestamp but zero-pads minutes too, e.g. "00:07" — the
 *  TikTok-style editor control-row format ("00:07 / 03:09"). */
export function formatTimestampPadded(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/** Time-of-day greeting, e.g. "good morning" / "good afternoon" / "good evening". */
export function timeGreeting(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return "good morning";
  if (hour < 18) return "good afternoon";
  return "good evening";
}
