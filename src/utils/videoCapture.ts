// Shared client-side video decode helpers — used by New project (initial
// upload) and Studio (Replace clip, add more footage). Kept in one place so
// there's exactly one implementation of "read a real duration" and "capture
// a real thumbnail frame" instead of two screens each growing their own.

/** One read attempt: mounts a throwaway <video> off-DOM, waits up to 15s
 *  for decoded metadata, and tears the element down completely on every
 *  exit path (timeout, error, or success) — clears the timeout, nulls out
 *  both handlers, blanks `src` (aborts an in-flight load so a slow decode
 *  can't fire a stray late callback after we've moved on), and revokes the
 *  object URL. Resolves `null` on failure, never 0 — 0 is a real duration
 *  for a real (if degenerate) clip, and this function has no way to know
 *  it's looking at one. */
function attemptReadDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    const finish = (duration: number | null) => {
      clearTimeout(timeout);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.src = "";
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    const timeout = setTimeout(() => finish(null), 15000);
    video.onloadedmetadata = () => {
      finish(Number.isFinite(video.duration) ? video.duration : null);
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}

/** Real client-side duration read (no backend/upload involved) — honest
 *  rather than inventing a fake per-clip duration for a real file the
 *  creator actually picked. `null` means unknown (still trying, or
 *  genuinely unreadable) — callers must not distinguish those cases, and
 *  must never treat `null` as 0. Retries once on failure (a fresh <video>
 *  + fresh timeout, not a reused element) before giving up: some
 *  browser/tab states (e.g. a backgrounded tab deferring video decode, or
 *  slow storage on a real device) can cost one attempt without the file
 *  actually being unreadable. */
export async function readVideoDuration(file: File): Promise<number | null> {
  const first = await attemptReadDuration(file);
  if (first !== null) return first;
  return attemptReadDuration(file);
}

/** Real client-side thumbnail capture — seeks a throwaway <video> to its
 *  first frame and draws it to a canvas. Same honesty/timeout shape as
 *  readVideoDuration: returns null (rather than a fake image) if the
 *  browser never gets around to decoding the frame in time, so callers can
 *  fall back to a clearly-flagged placeholder instead of a fake photo.
 *
 *  Logs at every failure point on purpose (not stripped after debugging) —
 *  this is the kind of thing that works fine in desktop Chrome but fails
 *  silently on a real phone, and the previous version had no way to tell
 *  timeout / thrown error / never-triggered apart from a phone's console.
 *
 *  `atSec` lets callers grab a frame partway through the clip (e.g. for a
 *  filmstrip that samples several points), defaulting to the effective
 *  first frame. */
export function captureVideoThumbnail(file: File, atSec?: number): Promise<string | null> {
  return new Promise((resolve) => {
    console.log(`[thumbnail] capture start: "${file.name}" (${file.size}B)${atSec != null ? ` @${atSec}s` : ""}`);
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    // Both the DOM property and the raw attribute — iOS Safari has, across
    // versions, only reliably honored one or the other for allowing
    // programmatic (non-user-gesture) playback/seeking.
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    // Critical real-device fix: a <video> that's never actually attached
    // to the document — even off-screen — does not reliably decode frames
    // on iOS Safari, though desktop Chrome tolerates a fully detached
    // element fine. The previous version never appended it at all, which
    // is almost certainly why capture silently never fired on a phone.
    video.style.cssText =
      "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(video);

    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
      video.remove();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      console.warn(`[thumbnail] timed out after 4s capturing "${file.name}" — never reached a seeked frame`);
      finish(null);
    }, 4000);

    function capture() {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 320;
        canvas.height = video.videoHeight || 320;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          console.warn(`[thumbnail] no 2d canvas context available for "${file.name}"`);
          finish(null);
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        console.log(`[thumbnail] captured "${file.name}" at ${canvas.width}x${canvas.height}`);
        finish(dataUrl);
      } catch (err) {
        console.warn(`[thumbnail] drawImage/toDataURL threw for "${file.name}"`, err);
        finish(null);
      }
    }

    video.onloadedmetadata = () => {
      // A muted play-then-immediately-pause "kick" before seeking is a
      // well-known iOS Safari requirement — without it, a seek on a video
      // that's never actually played can silently never produce a
      // paintable decoded frame (currentTime updates, `seeked` never
      // fires with real pixel data behind it).
      video
        .play()
        .then(() => video.pause())
        .catch((err) => console.warn(`[thumbnail] muted play-kick rejected for "${file.name}"`, err))
        .finally(() => {
          const duration = Number.isFinite(video.duration) ? video.duration : 0;
          if (atSec != null && duration > 0) {
            video.currentTime = Math.min(Math.max(atSec, 0), Math.max(duration - 0.05, 0));
          } else {
            video.currentTime = duration > 0.2 ? Math.min(0.1, duration - 0.05) : 0.01;
          }
        });
    };
    video.onseeked = capture;
    video.onerror = () => {
      console.warn(`[thumbnail] <video> element error for "${file.name}"`, video.error);
      finish(null);
    };
    video.src = url;
  });
}
