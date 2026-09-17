import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent, WheelEvent as ReactWheelEvent } from "react";
import { BackButton } from "../components/BackButton";
import { Placeholder } from "../components/Placeholder";
import {
  MOCK_TIMELINE_CLIPS,
  EDIT_RECEIPT,
  REVISION_PROMPT_PLACEHOLDER,
  REVISION_PROMPT_PLACEHOLDER_CLIP,
  PLACEHOLDER_CLIP_GRADIENTS,
  getEditExplanation,
} from "../data/placeholders";
import type { UploadedClip } from "../state/useAppFlow";
import { formatTimestampPadded } from "../utils/format";
import { readVideoDuration, captureVideoThumbnail } from "../utils/videoCapture";
import "./Studio.css";

interface WorkingClip {
  id: string;
  /** Any valid CSS `background` value — `url(...)` for a real captured
   *  frame, or a `linear-gradient(...)` when there's no real thumbnail to
   *  show (mock data, or a real clip whose capture failed/timed out). Tiled
   *  across the clip's filmstrip width to read as repeating frames. */
  thumbBackground: string;
  /** True for mock/fallback clips and for real clips with no captured
   *  thumbnail — drives whether the strip gets the fake-data dashed-border
   *  flag, same convention as everywhere else fake data renders. */
  isPlaceholder: boolean;
  durationSec: number;
  trimInSec: number;
  trimOutSec: number;
  speedMultiplier: number;
  volumePct: number;
  muted: boolean;
  overlayText: string;
  overlayFont: FontOption;
  /** Per-clip preview scale — the SAME value pinch-to-zoom on the preview
   *  and the Crop toolkit control both read/write. 1 = fit-to-frame; >1
   *  crops past the frame edges; <1 reveals letterbox bars. */
  scale: number;
}

type ToolTab = "speed" | "text" | "volume" | "crop";

const FONT_OPTIONS = ["sans", "serif", "mono", "display"] as const;
type FontOption = (typeof FONT_OPTIONS)[number];

const FONT_LABELS: Record<FontOption, string> = {
  sans: "Sans",
  serif: "Serif",
  mono: "Mono",
  display: "Display",
};

const SPEED_PRESETS = [0.5, 1, 1.5, 2];

const HOLD_MS = 260;
const MOVE_CANCEL_PX = 8;
const MIN_TRIM_GAP_SEC = 0.3;

// Timeline zoom: pixels-per-second at zoom 1, and how far zoom can go.
const BASE_PX_PER_SEC = 40;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const MIN_CLIP_WIDTH_PX = 22;

// Preview / crop scale range — shared by pinch-to-zoom and the Crop slider.
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

// "Nice" ruler tick intervals to choose between as zoom changes, in seconds.
const RULER_INTERVALS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const RULER_MIN_LABEL_GAP_PX = 64;

const MAX_HISTORY = 50;

function baseWorkingFields(durationSec: number) {
  return {
    durationSec,
    trimInSec: 0,
    trimOutSec: durationSec,
    speedMultiplier: 1,
    volumePct: 100,
    muted: false,
    overlayText: "",
    overlayFont: "sans" as FontOption,
    scale: 1,
  };
}

/** Fallback-only — see MOCK_TIMELINE_CLIPS. */
function toMockWorkingClips(): WorkingClip[] {
  return MOCK_TIMELINE_CLIPS.map((c) => ({
    id: c.id,
    thumbBackground: c.thumbBackground,
    isPlaceholder: true,
    ...baseWorkingFields(c.durationSec),
  }));
}

/** The real path — clips New project already uploaded, duration-read, and
 *  (best-effort) captured a thumbnail frame for. Reuses that thumbnail
 *  directly rather than re-decoding the same video Studio has no way to
 *  re-access anyway (New project only ever held a transient in-memory
 *  File/blob URL, not something carried through app state). */
function toWorkingClipsFromReal(clips: UploadedClip[]): WorkingClip[] {
  return clips.map((c, i) => {
    // A null/unread duration (duration-read failed even after New
    // Project's retry) would otherwise divide by zero throughout the
    // trim/split/timeline math below.
    const safeDuration = c.durationSec !== null && c.durationSec > 0 ? c.durationSec : 1;
    return {
      id: c.id,
      thumbBackground: c.thumbnailUrl
        ? `url(${c.thumbnailUrl})`
        : PLACEHOLDER_CLIP_GRADIENTS[i % PLACEHOLDER_CLIP_GRADIENTS.length],
      isPlaceholder: !c.thumbnailUrl,
      ...baseWorkingFields(safeDuration),
    };
  });
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

/** Picks the smallest "nice" interval (0.5s, 1s, 2s, 5s, 10s...) whose
 *  on-screen spacing at the given px/sec is still readable — finer when
 *  zoomed in, coarser when zoomed out. */
function pickRulerInterval(pxPerSec: number): number {
  for (const interval of RULER_INTERVALS) {
    if (interval * pxPerSec >= RULER_MIN_LABEL_GAP_PX) return interval;
  }
  return RULER_INTERVALS[RULER_INTERVALS.length - 1];
}

/** Same MM:SS shape as formatTimestampPadded, but keeps one decimal place
 *  on the seconds when the ruler's own tick interval is sub-second —
 *  otherwise two adjacent 0.5s-apart ticks both round to the same whole
 *  second and print identical labels. */
function formatRulerLabel(sec: number, interval: number): string {
  if (interval >= 1) return formatTimestampPadded(sec);
  const safeSec = Math.max(0, sec);
  const m = Math.floor(safeSec / 60);
  const s = safeSec % 60;
  return `${m.toString().padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

/** Distance between two touch points — the building block for pinch. */
function touchDistance(touches: React.TouchList): number {
  const [a, b] = [touches[0], touches[1]];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/**
 * Real Studio screen — TikTok-editor-parity structure (ergonomics copied,
 * not the skin: forced light mode, black primary actions, our type/spacing).
 * Four zones stacked with no dead space between them: (1) preview, full
 * width and edge to edge, taking whatever height the other three don't
 * need; (2) receipt line + transport row; (3) timeline, always visible,
 * sized to its own content rather than stretched; (4) toolbar + prompt bar,
 * pinned to the bottom. A fixed center playhead with a proportional-width
 * filmstrip scrolls underneath it in zone 3. The clips themselves are the
 * real footage New project uploaded (real thumbnails reused as-is, not
 * re-decoded) whenever any were uploaded; MOCK_TIMELINE_CLIPS is a fallback
 * for the one path that genuinely has no real footage to show (opening an
 * existing project, which isn't backed by real stored clips yet).
 * EDIT_RECEIPT stays mock either way — real edit generation is backend work
 * that doesn't exist yet.
 */
export function Studio({
  onBack,
  initialClips,
  creatorStyles,
  prompt,
  styleIds,
  onFirstPlay,
}: {
  onBack: () => void;
  initialClips: UploadedClip[];
  /** Picked on "Your Style" at onboarding — shown alongside the mock edit
   *  summary as a small trace of what's shaping this edit. Creator-level,
   *  not project-level, so it's the same regardless of which project is
   *  open. Empty if the creator skipped that step. */
  creatorStyles: string[];
  /** The recipe text and ingredients from New Project screen 2 — drives
   *  the edit-explanation line (see getEditExplanation). Empty for the
   *  one path with no real draft behind it (opening an existing project
   *  from the mock Existing Projects list). */
  prompt: string;
  styleIds: string[];
  /** Fires once, the first time playback actually starts (not on mount,
   *  not on merely opening this screen) — the signal My Projects' unread
   *  dot waits for. Tapping in and backing out without pressing play must
   *  leave the dot in place. Optional: the only caller that cares is the
   *  My Projects → Studio path. */
  onFirstPlay?: () => void;
}) {
  const [clips, setClips] = useState<WorkingClip[]>(() =>
    initialClips.length > 0 ? toWorkingClipsFromReal(initialClips) : toMockWorkingClips()
  );
  const [explanationExpanded, setExplanationExpanded] = useState(false);
  const editExplanation = getEditExplanation(prompt, styleIds);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toolPanel, setToolPanel] = useState<ToolTab | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragX, setDragX] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [revisionPrompt, setRevisionPrompt] = useState("");
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [historyIndex, setHistoryIndex] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollRafRef = useRef<number | null>(null);
  const autoScrollingRef = useRef(false);
  const prevOffsetsRef = useRef<Map<string, number>>(new Map());
  const splitCounterRef = useRef(0);
  const playheadSecRef = useRef(0);
  const addFileInputRef = useRef<HTMLInputElement>(null);
  const replaceFileInputRef = useRef<HTMLInputElement>(null);
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Undo/redo — a real (not cosmetic) history of the clips array, pushed
  // after every structural or toolkit edit. Kept as a ref (not state) since
  // it shouldn't itself trigger renders; historyIndex (state) drives the
  // undo/redo button disabled state and re-renders.
  const historyRef = useRef<WorkingClip[][]>([clips]);
  const historyIndexRef = useRef(0);
  const suppressHistoryRef = useRef(false);

  // Gesture-disambiguation state for tap-vs-hold-drag — kept in a ref since
  // none of it should ever trigger a re-render on its own.
  const dragGestureRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    lastClientX: number;
    holdTimer: ReturnType<typeof setTimeout> | null;
    dragging: boolean;
  } | null>(null);

  const trimGestureRef = useRef<{
    which: "in" | "out";
    startX: number;
    startIn: number;
    startOut: number;
  } | null>(null);

  // Pinch state — one for the preview frame (per-clip scale), one for the
  // timeline (global zoom). Also doubles as ctrl+wheel state on desktop so
  // this is testable without a real touch device.
  const previewPinchRef = useRef<{ startDist: number; startScale: number; clipId: string } | null>(null);
  const timelinePinchRef = useRef<{ startDist: number; startZoom: number; anchorSec: number } | null>(null);

  // Set right before a reorder, consumed by the FLIP effect below to keep
  // the DRAGGED tile's own transform continuous across the layout jump a
  // reorder causes (it now occupies a different flex slot, so its
  // offsetLeft changes even though the pointer hasn't moved further).
  const pendingDragJumpRef = useRef<{ id: string; prevOffsetLeft: number } | null>(null);

  // Mirrors `clips` for gesture-end handlers (trim/pinch release) that call
  // pushHistory(clips) — those handlers can fire back-to-back with their
  // preceding move events in the same batch (a fast flick, or a
  // programmatically-dispatched gesture), which would otherwise read a
  // closure-stale `clips` from before the gesture's last update landed and
  // push a bogus duplicate history entry instead of the real end state.
  const clipsRef = useRef(clips);
  useLayoutEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  const pxPerSec = BASE_PX_PER_SEC * timelineZoom;

  // Cumulative layout of the (trimmed) timeline — one source of truth used
  // by rendering, scroll math, the split point, and "which clip is under
  // the playhead."
  const layout = useMemo(() => {
    let cursor = 0;
    return clips.map((c) => {
      const durSec = Math.max(0, c.trimOutSec - c.trimInSec);
      const startSec = cursor;
      cursor += durSec;
      return { clip: c, startSec, endSec: cursor, durSec, widthPx: Math.max(MIN_CLIP_WIDTH_PX, durSec * pxPerSec) };
    });
  }, [clips, pxPerSec]);

  const totalDurationSec = layout.length > 0 ? layout[layout.length - 1].endSec : 0;
  const selectedClip = clips.find((c) => c.id === selectedId) ?? null;
  const centeredEntry =
    layout.find((l) => playheadSec >= l.startSec && playheadSec < l.endSec) ?? layout[layout.length - 1];
  const centeredClip = centeredEntry?.clip ?? clips[0];

  function flashNote(text: string) {
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    setNote(text);
    noteTimerRef.current = setTimeout(() => setNote(null), 2500);
  }

  // ---- undo/redo history ----
  function pushHistory(next: WorkingClip[]) {
    if (suppressHistoryRef.current) return;
    const truncated = historyRef.current.slice(0, historyIndexRef.current + 1);
    truncated.push(next);
    if (truncated.length > MAX_HISTORY) truncated.shift();
    historyRef.current = truncated;
    historyIndexRef.current = truncated.length - 1;
    setHistoryIndex(historyIndexRef.current);
  }

  function applyClips(updater: (prev: WorkingClip[]) => WorkingClip[], recordHistory = true) {
    setClips((prev) => {
      const next = updater(prev);
      if (recordHistory && next !== prev) pushHistory(next);
      return next;
    });
  }

  function undo() {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current -= 1;
    setHistoryIndex(historyIndexRef.current);
    suppressHistoryRef.current = true;
    setClips(historyRef.current[historyIndexRef.current]);
    suppressHistoryRef.current = false;
    setSelectedId(null);
  }

  function redo() {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current += 1;
    setHistoryIndex(historyIndexRef.current);
    suppressHistoryRef.current = true;
    setClips(historyRef.current[historyIndexRef.current]);
    suppressHistoryRef.current = false;
    setSelectedId(null);
  }

  // ---- scroll <-> time mapping (fixed center playhead) ----
  // The leading/trailing spacers are each exactly half the viewport wide,
  // so scrollLeft === 0 puts t=0 at center and scrollLeft === totalDurationSec
  // * pxPerSec puts the last frame at center — playheadSec is just scrollLeft
  // converted to seconds, no rect-measurement needed.
  function handleTimelineScroll() {
    if (scrollRafRef.current == null) {
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        const container = scrollRef.current;
        if (!container) return;
        const sec = clamp(container.scrollLeft / pxPerSec, 0, totalDurationSec);
        playheadSecRef.current = sec;
        setPlayheadSec(sec);
      });
    }
    if (!autoScrollingRef.current) setIsPlaying(false);
  }

  function scrollToSec(sec: number) {
    const container = scrollRef.current;
    if (!container) return;
    autoScrollingRef.current = true;
    container.scrollLeft = sec * pxPerSec;
    autoScrollingRef.current = false;
  }

  // Re-anchor scroll position whenever zoom changes so the same playhead
  // time stays centered through the pinch/wheel gesture.
  useLayoutEffect(() => {
    scrollToSec(playheadSecRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineZoom]);

  // Mount-only.
  useLayoutEffect(() => {
    scrollToSec(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- playback: auto-scroll the timeline + advance the clock ----
  const hasFiredFirstPlayRef = useRef(false);
  function togglePlay() {
    setIsPlaying((p) => {
      const next = !p;
      if (next && !hasFiredFirstPlayRef.current) {
        hasFiredFirstPlayRef.current = true;
        onFirstPlay?.();
      }
      return next;
    });
  }

  useLayoutEffect(() => {
    if (!isPlaying) return;
    let last = performance.now();
    let raf: number;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const next = clamp(playheadSecRef.current + dt, 0, totalDurationSec);
      playheadSecRef.current = next;
      setPlayheadSec(next);
      scrollToSec(next);
      if (next >= totalDurationSec) {
        setIsPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // ---- FLIP-style shift animation for tiles displaced by a reorder ----
  useLayoutEffect(() => {
    const prev = prevOffsetsRef.current;
    if (prev.size > 0) {
      clips.forEach((c) => {
        if (c.id === draggingId) return; // the dragged tile is handled below, not FLIP
        const tile = tileRefs.current.get(c.id);
        const prevLeft = prev.get(c.id);
        if (!tile || prevLeft == null) return;
        const delta = prevLeft - tile.offsetLeft;
        if (delta === 0) return;
        tile.style.transition = "none";
        tile.style.transform = `translateX(${delta}px)`;
        tile.getBoundingClientRect(); // force reflow before releasing the transition
        tile.style.transition = "transform 0.18s ease";
        tile.style.transform = "";
      });
      prevOffsetsRef.current = new Map();
    }

    // The dragged tile itself just landed in a new flex slot (different
    // offsetLeft) as a side effect of the same reorder — without this, the
    // next dx calculation would read as a sudden jump and could cascade
    // into further unintended swaps far beyond the pointer's real travel.
    const pendingJump = pendingDragJumpRef.current;
    pendingDragJumpRef.current = null;
    if (pendingJump && dragGestureRef.current?.id === pendingJump.id) {
      const tile = tileRefs.current.get(pendingJump.id);
      if (tile) {
        const jump = tile.offsetLeft - pendingJump.prevOffsetLeft;
        const gesture = dragGestureRef.current;
        gesture.startX += jump;
        setDragX(gesture.lastClientX - gesture.startX);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);

  function captureOffsetsForFlip() {
    const map = new Map<string, number>();
    clips.forEach((c) => {
      const tile = tileRefs.current.get(c.id);
      if (tile) map.set(c.id, tile.offsetLeft);
    });
    prevOffsetsRef.current = map;
  }

  function reorder(fromId: string, toIndex: number, recordHistory: boolean) {
    captureOffsetsForFlip();
    const draggedTile = tileRefs.current.get(fromId);
    if (draggedTile) {
      pendingDragJumpRef.current = { id: fromId, prevOffsetLeft: draggedTile.offsetLeft };
    }
    applyClips((prev) => {
      const fromIndex = prev.findIndex((c) => c.id === fromId);
      if (fromIndex === -1 || fromIndex === toIndex) return prev;
      const next = [...prev];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      return next;
    }, recordHistory);
  }

  // ---- tap-vs-hold-drag gesture handling on each filmstrip clip ----
  function handleTilePointerDown(e: ReactPointerEvent<HTMLDivElement>, id: string) {
    // Can throw if the browser doesn't consider this pointer id "active"
    // (e.g. certain synthetic/replayed events) — capture is a nice-to-have
    // for reliable tracking off-element, not something the gesture should
    // hard-fail without.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Best-effort.
    }
    const holdTimer = setTimeout(() => {
      const gesture = dragGestureRef.current;
      if (gesture && gesture.id === id) {
        gesture.dragging = true;
        setDraggingId(id);
        setDragX(0);
      }
    }, HOLD_MS);
    dragGestureRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      lastClientX: e.clientX,
      holdTimer,
      dragging: false,
    };
  }

  function handleTilePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const gesture = dragGestureRef.current;
    if (!gesture) return;
    gesture.lastClientX = e.clientX;
    const dx = e.clientX - gesture.startX;
    const dy = e.clientY - gesture.startY;

    if (!gesture.dragging) {
      // Real movement before the hold fires means this is a scroll, not a
      // pick-up — bail out and let the browser's native scroll continue.
      if (Math.abs(dx) > MOVE_CANCEL_PX || Math.abs(dy) > MOVE_CANCEL_PX) {
        if (gesture.holdTimer) clearTimeout(gesture.holdTimer);
        dragGestureRef.current = null;
      }
      return;
    }

    setDragX(dx);

    const tile = tileRefs.current.get(gesture.id);
    if (!tile) return;
    // offsetLeft is transform-independent, so this stays correct across
    // however many reorders have already happened mid-drag.
    const draggedCenter = tile.offsetLeft + dx + tile.offsetWidth / 2;
    const currentIndex = clips.findIndex((c) => c.id === gesture.id);

    if (currentIndex < clips.length - 1) {
      const rightTile = tileRefs.current.get(clips[currentIndex + 1].id);
      if (rightTile) {
        const rightCenter = rightTile.offsetLeft + rightTile.offsetWidth / 2;
        if (draggedCenter > rightCenter) {
          reorder(gesture.id, currentIndex + 1, false);
          return;
        }
      }
    }
    if (currentIndex > 0) {
      const leftTile = tileRefs.current.get(clips[currentIndex - 1].id);
      if (leftTile) {
        const leftCenter = leftTile.offsetLeft + leftTile.offsetWidth / 2;
        if (draggedCenter < leftCenter) {
          reorder(gesture.id, currentIndex - 1, false);
        }
      }
    }
  }

  function handleTilePointerUp(e: ReactPointerEvent<HTMLDivElement>, id: string) {
    const gesture = dragGestureRef.current;
    if (!gesture) return;
    if (gesture.holdTimer) clearTimeout(gesture.holdTimer);
    if (gesture.dragging) {
      setDraggingId(null);
      setDragX(0);
      // The reorder(s) mid-drag were skipped from history to avoid a noisy
      // undo stack (one entry per tile swap) — record the final order once.
      pushHistory(clipsRef.current);
    } else {
      const dx = Math.abs(e.clientX - gesture.startX);
      const dy = Math.abs(e.clientY - gesture.startY);
      if (dx < MOVE_CANCEL_PX && dy < MOVE_CANCEL_PX) {
        setSelectedId((prevId) => (prevId === id ? null : id));
        setToolPanel(null);
      }
    }
    dragGestureRef.current = null;
  }

  // ---- trim handles directly on the selected filmstrip clip ----
  function handleTrimPointerDown(e: ReactPointerEvent<HTMLDivElement>, which: "in" | "out") {
    if (!selectedClip) return;
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Best-effort.
    }
    trimGestureRef.current = {
      which,
      startX: e.clientX,
      startIn: selectedClip.trimInSec,
      startOut: selectedClip.trimOutSec,
    };
  }

  function handleTrimPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const gesture = trimGestureRef.current;
    if (!gesture || !selectedId) return;
    e.stopPropagation();
    const dx = e.clientX - gesture.startX;
    const dSec = dx / pxPerSec;
    applyClips(
      (prev) =>
        prev.map((c) => {
          if (c.id !== selectedId) return c;
          if (gesture.which === "in") {
            const next = clamp(gesture.startIn + dSec, 0, c.trimOutSec - MIN_TRIM_GAP_SEC);
            return { ...c, trimInSec: next };
          }
          const next = clamp(gesture.startOut + dSec, c.trimInSec + MIN_TRIM_GAP_SEC, c.durationSec);
          return { ...c, trimOutSec: next };
        }),
      false
    );
  }

  function handleTrimPointerUp() {
    if (trimGestureRef.current) pushHistory(clipsRef.current);
    trimGestureRef.current = null;
  }

  function updateSelectedClip(patch: Partial<WorkingClip>) {
    if (!selectedId) return;
    applyClips((prev) => prev.map((c) => (c.id === selectedId ? { ...c, ...patch } : c)));
  }

  function toggleMute() {
    if (!selectedClip) return;
    updateSelectedClip({ muted: !selectedClip.muted });
  }

  // ---- split — the structural tool: actually divides the clip in two,
  //      cutting at the fixed center playhead ----
  function performSplit() {
    const entry = layout.find((l) => l.clip.id === selectedId);
    if (!entry) return;
    const { clip, startSec, endSec } = entry;
    if (playheadSec <= startSec || playheadSec >= endSec) {
      flashNote("Move the Playhead Inside This Clip to Split");
      return;
    }
    const localSplitSec = clip.trimInSec + (playheadSec - startSec);
    if (localSplitSec - clip.trimInSec < MIN_TRIM_GAP_SEC || clip.trimOutSec - localSplitSec < MIN_TRIM_GAP_SEC) {
      flashNote("Move the Playhead Inside This Clip to Split");
      return;
    }

    splitCounterRef.current += 1;
    const suffix = splitCounterRef.current;
    const firstHalf: WorkingClip = { ...clip, id: `${clip.id}_split${suffix}a`, trimOutSec: localSplitSec };
    const secondHalf: WorkingClip = { ...clip, id: `${clip.id}_split${suffix}b`, trimInSec: localSplitSec };

    applyClips((prev) => {
      const idx = prev.findIndex((c) => c.id === clip.id);
      if (idx === -1) return prev;
      const next = [...prev];
      next.splice(idx, 1, firstHalf, secondHalf);
      return next;
    });
    setSelectedId(null);
    setToolPanel(null);
  }

  function deleteSelectedClip() {
    if (!selectedId || clips.length <= 1) return;
    applyClips((prev) => prev.filter((c) => c.id !== selectedId));
    setSelectedId(null);
    setToolPanel(null);
  }

  // ---- replace — swap this clip's footage, keeping its position/duration ----
  function openReplace() {
    if (!selectedId) return;
    replaceFileInputRef.current?.click();
  }

  async function handleReplaceFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !selectedId) return;
    const currentTrimmedLen =
      (selectedClip?.trimOutSec ?? 0) - (selectedClip?.trimInSec ?? 0);
    console.log(`[replace] swapping footage for clip ${selectedId}: "${file.name}"`);
    try {
      const [durationSec, thumbnailUrl] = await Promise.all([
        readVideoDuration(file),
        captureVideoThumbnail(file),
      ]);
      // readVideoDuration now returns null (unknown/unreadable) instead of
      // 0 — Studio's own clip model has no "unknown duration" state (it
      // always needs a real number to drive trim math), so null folds
      // into the same 1s fallback 0 used to, unchanged from before.
      const safeDuration = durationSec !== null && durationSec > 0 ? durationSec : 1;
      applyClips((prev) =>
        prev.map((c) => {
          if (c.id !== selectedId) return c;
          const keptLen = Math.min(currentTrimmedLen || safeDuration, safeDuration);
          return {
            ...c,
            durationSec: safeDuration,
            trimInSec: 0,
            trimOutSec: keptLen,
            thumbBackground: thumbnailUrl ? `url(${thumbnailUrl})` : PLACEHOLDER_CLIP_GRADIENTS[0],
            isPlaceholder: !thumbnailUrl,
          };
        })
      );
      console.log(`[replace] done — new duration ${safeDuration.toFixed(2)}s, thumbnail ${thumbnailUrl ? "captured" : "unavailable"}`);
    } catch (err) {
      console.warn(`[replace] failed for "${file.name}"`, err);
      flashNote("Couldn't Read That File");
    }
  }

  // ---- "+" add more footage at the end of the filmstrip ----
  function openAddFootage() {
    addFileInputRef.current?.click();
  }

  async function handleAddFootageFiles(e: ChangeEvent<HTMLInputElement>) {
    // Materialize the actual File objects BEFORE clearing e.target.value —
    // `.files` returns a live FileList tied to the input's current
    // selection, so resetting `.value` empties it retroactively too, and a
    // held reference (rather than an extracted array) would silently see
    // zero files by the time it's read.
    const fileList = e.target.files;
    const files = fileList ? Array.from(fileList) : [];
    e.target.value = "";
    if (files.length === 0) return;
    console.log(`[add-footage] reading ${files.length} file(s)`);
    try {
      const added = await Promise.all(
        files.map(async (file) => {
          const [durationSec, thumbnailUrl] = await Promise.all([
            readVideoDuration(file),
            captureVideoThumbnail(file),
          ]);
          const safeDuration = durationSec !== null && durationSec > 0 ? durationSec : 1;
          const clip: WorkingClip = {
            id: `${file.name}-${file.size}-${file.lastModified}`,
            thumbBackground: thumbnailUrl ? `url(${thumbnailUrl})` : PLACEHOLDER_CLIP_GRADIENTS[0],
            isPlaceholder: !thumbnailUrl,
            ...baseWorkingFields(safeDuration),
          };
          return clip;
        })
      );
      applyClips((prev) => [...prev, ...added]);
      console.log(`[add-footage] appended ${added.length} clip(s)`);
    } catch (err) {
      console.warn("[add-footage] failed", err);
      flashNote("Couldn't Read That Footage");
    }
  }

  function tapRevisionSend() {
    if (!revisionPrompt.trim()) return;
    flashNote("Revisions Aren't Set Up Yet");
    setRevisionPrompt("");
    setPromptExpanded(false);
  }

  function deselect() {
    setSelectedId(null);
    setToolPanel(null);
  }

  // ---- pinch-to-zoom: preview (per-clip scale) ----
  function handlePreviewTouchStart(e: ReactTouchEvent<HTMLDivElement>) {
    if (e.touches.length !== 2 || !centeredClip) return;
    previewPinchRef.current = {
      startDist: touchDistance(e.touches),
      startScale: centeredClip.scale,
      clipId: centeredClip.id,
    };
  }

  function handlePreviewTouchMove(e: ReactTouchEvent<HTMLDivElement>) {
    const gesture = previewPinchRef.current;
    if (!gesture || e.touches.length !== 2) return;
    e.preventDefault();
    const ratio = touchDistance(e.touches) / gesture.startDist;
    const next = clamp(gesture.startScale * ratio, MIN_SCALE, MAX_SCALE);
    applyClips((prev) => prev.map((c) => (c.id === gesture.clipId ? { ...c, scale: next } : c)), false);
  }

  function handlePreviewTouchEnd(e: ReactTouchEvent<HTMLDivElement>) {
    if (e.touches.length < 2) {
      if (previewPinchRef.current) pushHistory(clipsRef.current);
      previewPinchRef.current = null;
    }
  }

  // Trackpad pinch on desktop Chrome/Safari surfaces as wheel + ctrlKey —
  // lets this be exercised without a real touch device.
  function handlePreviewWheel(e: ReactWheelEvent<HTMLDivElement>) {
    if (!e.ctrlKey || !centeredClip) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.01);
    const clipId = centeredClip.id;
    applyClips(
      (prev) =>
        prev.map((c) => (c.id === clipId ? { ...c, scale: clamp(c.scale * factor, MIN_SCALE, MAX_SCALE) } : c)),
      false
    );
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    noteTimerRef.current = setTimeout(() => pushHistory(clipsRef.current), 400);
  }

  // ---- pinch-to-zoom: timeline (global zoom, anchored at the playhead) ----
  function handleTimelineTouchStart(e: ReactTouchEvent<HTMLDivElement>) {
    if (e.touches.length !== 2) return;
    timelinePinchRef.current = {
      startDist: touchDistance(e.touches),
      startZoom: timelineZoom,
      anchorSec: playheadSecRef.current,
    };
  }

  function handleTimelineTouchMove(e: ReactTouchEvent<HTMLDivElement>) {
    const gesture = timelinePinchRef.current;
    if (!gesture || e.touches.length !== 2) return;
    e.preventDefault();
    const ratio = touchDistance(e.touches) / gesture.startDist;
    setTimelineZoom(clamp(gesture.startZoom * ratio, MIN_ZOOM, MAX_ZOOM));
  }

  function handleTimelineTouchEnd(e: ReactTouchEvent<HTMLDivElement>) {
    if (e.touches.length < 2) timelinePinchRef.current = null;
  }

  function handleTimelineWheel(e: ReactWheelEvent<HTMLDivElement>) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.01);
    setTimelineZoom((z) => clamp(z * factor, MIN_ZOOM, MAX_ZOOM));
  }

  const rulerInterval = pickRulerInterval(pxPerSec);
  const rulerTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let t = 0; t <= totalDurationSec + 0.001; t += rulerInterval) ticks.push(t);
    return ticks;
  }, [totalDurationSec, rulerInterval]);

  const previewScale = centeredClip?.scale ?? 1;

  const previewFrame = (
    <div
      className="pbj-studio__preview-frame"
      onTouchStart={handlePreviewTouchStart}
      onTouchMove={handlePreviewTouchMove}
      onTouchEnd={handlePreviewTouchEnd}
      onTouchCancel={handlePreviewTouchEnd}
      onWheel={handlePreviewWheel}
    >
      <div
        className="pbj-studio__preview-frame-inner"
        style={{ background: centeredClip?.thumbBackground, transform: `scale(${previewScale})` }}
      />
      {selectedClip && (
        <>
          <div className="pbj-studio__preview-guide pbj-studio__preview-guide--left" aria-hidden="true" />
          <div className="pbj-studio__preview-guide pbj-studio__preview-guide--right" aria-hidden="true" />
        </>
      )}
    </div>
  );

  return (
    <div className="pbj-studio">
      <input
        ref={addFileInputRef}
        type="file"
        accept="video/*"
        multiple
        className="pbj-studio__file-input"
        onChange={handleAddFootageFiles}
      />
      <input
        ref={replaceFileInputRef}
        type="file"
        accept="video/*"
        className="pbj-studio__file-input"
        onChange={handleReplaceFile}
      />

      <div className="pbj-studio__top-row">
        <BackButton onClick={onBack} />

        <button
          type="button"
          className="pbj-studio__next"
          onClick={() => flashNote("Export Isn't Set Up Yet")}
          aria-label="Next"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 12h13M12 5l7 7-7 7"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {/* Zone 1 — preview player, full width edge to edge, 9:16 frame that
          takes whatever vertical space the other three zones don't need.
          Always reflects whichever clip the fixed playhead is currently
          over. Pinch (or ctrl+wheel, for desktop testing) scales that clip
          within the frame; scale persists per clip and is the same value
          the Crop toolkit control edits. */}
      <section className="pbj-studio__preview">
        {centeredClip?.isPlaceholder === false ? (
          <div className="pbj-studio__preview-frame-wrap">{previewFrame}</div>
        ) : (
          <Placeholder className="pbj-studio__preview-frame-wrap">{previewFrame}</Placeholder>
        )}
      </section>

      {/* Zone 2 — receipt line + transport row, directly under the preview. */}
      <section className="pbj-studio__receipt-transport">
        {/* Edit explanation — collapsed to one plain sentence by default,
            always. No card/border/icon/fill: it must cost almost nothing
            visually until tapped. Stays visible regardless of clip
            selection (unlike the receipt line below it) since it's
            explaining the WHOLE edit, not something tied to one clip. */}
        <button
          type="button"
          className="pbj-studio__edit-explanation"
          onClick={() => setExplanationExpanded((v) => !v)}
          aria-expanded={explanationExpanded}
        >
          <span className="pbj-studio__edit-explanation-summary">{editExplanation.summary}</span>
          <span
            className={
              "pbj-studio__edit-explanation-reasoning-wrap" +
              (explanationExpanded ? " pbj-studio__edit-explanation-reasoning-wrap--expanded" : "")
            }
          >
            <span className="pbj-studio__edit-explanation-reasoning-inner">
              <span className="pbj-studio__edit-explanation-reasoning">{editExplanation.reasoning}</span>
            </span>
          </span>
        </button>

        {!selectedClip && (
          <Placeholder inline className="pbj-studio__summary-wrap">
            <p className="pbj-studio__summary">{EDIT_RECEIPT}</p>
          </Placeholder>
        )}

        {!selectedClip && creatorStyles.length > 0 && (
          <p className="pbj-studio__creator-styles">Styled For: {creatorStyles.join(", ")}</p>
        )}

        <div className="pbj-studio__control-row">
          <span className="pbj-studio__time-readout">
            {formatTimestampPadded(playheadSec)} / {formatTimestampPadded(totalDurationSec)}
          </span>
          <button
            type="button"
            className="pbj-studio__control-play"
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="5" y="4" width="5" height="16" rx="1.5" />
                <rect x="14" y="4" width="5" height="16" rx="1.5" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 4.5c0-1.1 1.2-1.8 2.2-1.2l12 7.5a1.4 1.4 0 0 1 0 2.4l-12 7.5c-1 .6-2.2-.1-2.2-1.2v-15z" />
              </svg>
            )}
          </button>
          <div className="pbj-studio__control-icons">
            <button
              type="button"
              className="pbj-studio__icon-btn"
              onClick={undo}
              disabled={historyIndex <= 0}
              aria-label="Undo"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path d="M7 7H17a5 5 0 0 1 0 10h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M10 3.5L6.5 7 10 10.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              className="pbj-studio__icon-btn"
              onClick={redo}
              disabled={historyIndex >= historyRef.current.length - 1}
              aria-label="Redo"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path d="M17 7H7a5 5 0 0 0 0 10h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M14 3.5L17.5 7 14 10.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              className="pbj-studio__icon-btn"
              onClick={() => flashNote("Fullscreen Isn't Set Up Yet")}
              aria-label="Expand"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path
                  d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </section>

      {/* Zone 3 — timeline, sitting tight under the transport row with no
          dead space above or below. Playhead fixed at center, filmstrip
          scrolls underneath with fluid momentum scrolling. Pinch (or
          ctrl+wheel) zooms, anchored on the playhead. Always visible —
          never hidden or collapsed. */}
      <section className="pbj-studio__timeline-section">
        <div
          className="pbj-studio__timeline-viewport"
          onTouchStart={handleTimelineTouchStart}
          onTouchMove={handleTimelineTouchMove}
          onTouchEnd={handleTimelineTouchEnd}
          onTouchCancel={handleTimelineTouchEnd}
          onWheel={handleTimelineWheel}
        >
          <div className="pbj-studio__playhead" aria-hidden="true" />
          <div className="pbj-studio__timeline-scroll" ref={scrollRef} onScroll={handleTimelineScroll}>
            <div className="pbj-studio__timeline-content" style={{ width: totalDurationSec * pxPerSec }}>
              {/* Ruler — same scroll container as the filmstrip, so it
                  tracks in perfect sync with zero extra code. */}
              <div className="pbj-studio__ruler">
                {rulerTicks.map((t) => (
                  <div key={t} className="pbj-studio__ruler-tick" style={{ left: t * pxPerSec }}>
                    <span className="pbj-studio__ruler-mark" />
                    <span className="pbj-studio__ruler-label">{formatRulerLabel(t, rulerInterval)}</span>
                  </div>
                ))}
              </div>

              <div className="pbj-studio__filmstrip" onClick={deselect}>
                {layout.map(({ clip: c, widthPx }, i) => (
                  <div key={c.id} className="pbj-studio__strip-group">
                    {i > 0 && (
                      <button
                        type="button"
                        className="pbj-studio__transition-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          flashNote("Transitions Aren't Set Up Yet");
                        }}
                        aria-label="Transition"
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M2 4l9 8-9 8V4z" />
                          <path d="M22 4l-9 8 9 8V4z" />
                        </svg>
                      </button>
                    )}
                    <div
                      ref={(el) => {
                        if (el) tileRefs.current.set(c.id, el);
                        else tileRefs.current.delete(c.id);
                      }}
                      className={
                        "pbj-studio__strip" +
                        (draggingId === c.id ? " pbj-studio__strip--dragging" : "") +
                        (selectedId === c.id ? " pbj-studio__strip--selected" : "") +
                        (c.isPlaceholder ? " pbj-studio__strip--placeholder" : "")
                      }
                      style={{
                        width: widthPx,
                        background: c.thumbBackground,
                        backgroundRepeat: "repeat-x",
                        backgroundSize: "40px 100%",
                        transform: draggingId === c.id ? `translateX(${dragX}px)` : undefined,
                        touchAction: draggingId === c.id ? "none" : "pan-x",
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => handleTilePointerDown(e, c.id)}
                      onPointerMove={handleTilePointerMove}
                      onPointerUp={(e) => handleTilePointerUp(e, c.id)}
                      onPointerCancel={(e) => handleTilePointerUp(e, c.id)}
                    >
                      <span className="pbj-studio__strip-speed">×{c.speedMultiplier.toFixed(2)}</span>
                      {(c.muted || c.volumePct === 0) && (
                        <span className="pbj-studio__strip-muted" aria-label="Muted">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                            <path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor" />
                            <path d="M16 8l5 8M21 8l-5 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                          </svg>
                        </span>
                      )}

                      {selectedId === c.id && (
                        <>
                          <div className="pbj-studio__trim-badge">
                            {(c.trimOutSec - c.trimInSec).toFixed(1)}s
                          </div>
                          <div
                            className="pbj-studio__trim-handle pbj-studio__trim-handle--in"
                            onPointerDown={(e) => handleTrimPointerDown(e, "in")}
                            onPointerMove={handleTrimPointerMove}
                            onPointerUp={handleTrimPointerUp}
                            onPointerCancel={handleTrimPointerUp}
                            aria-label="Trim start"
                          >
                            <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
                              <path d="M6 1L1 6l5 5" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </div>
                          <div
                            className="pbj-studio__trim-handle pbj-studio__trim-handle--out"
                            onPointerDown={(e) => handleTrimPointerDown(e, "out")}
                            onPointerMove={handleTrimPointerMove}
                            onPointerUp={handleTrimPointerUp}
                            onPointerCancel={handleTrimPointerUp}
                            aria-label="Trim end"
                          >
                            <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
                              <path d="M1 1l5 5-5 5" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ))}

                <button type="button" className="pbj-studio__add-footage" onClick={openAddFootage} aria-label="Add more footage">
                  +
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {note && <p className="pbj-studio__note">{note}</p>}

      {/* Optional expanded panel for the clip toolkit items that need more
          than a single tap (speed / text / volume / crop). */}
      {selectedClip && toolPanel && (
        <section className="pbj-studio__tool-panel">
          {toolPanel === "speed" && (
            <div className="pbj-studio__speed-panel">
              {SPEED_PRESETS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={
                    "pbj-studio__speed-chip" + (selectedClip.speedMultiplier === s ? " pbj-studio__speed-chip--selected" : "")
                  }
                  onClick={() => updateSelectedClip({ speedMultiplier: s })}
                >
                  {s}×
                </button>
              ))}
            </div>
          )}

          {toolPanel === "text" && (
            <div className="pbj-studio__text-panel">
              <input
                type="text"
                className="pbj-studio__text-input"
                placeholder="Add a Caption or Title"
                value={selectedClip.overlayText}
                onChange={(e) => updateSelectedClip({ overlayText: e.target.value })}
              />
              <div className="pbj-studio__font-row">
                {FONT_OPTIONS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={
                      `pbj-studio__font-chip pbj-studio__font-chip--${f}` +
                      (selectedClip.overlayFont === f ? " pbj-studio__font-chip--selected" : "")
                    }
                    onClick={() => updateSelectedClip({ overlayFont: f })}
                  >
                    {FONT_LABELS[f]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {toolPanel === "volume" && (
            <div className="pbj-studio__volume-panel">
              <button
                type="button"
                className={"pbj-studio__mute-btn" + (selectedClip.muted ? " pbj-studio__mute-btn--active" : "")}
                onClick={toggleMute}
              >
                {selectedClip.muted ? "Unmute" : "Mute"}
              </button>
              <input
                type="range"
                className="pbj-studio__range"
                min={0}
                max={100}
                step={1}
                value={selectedClip.volumePct}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  updateSelectedClip({ volumePct: next, muted: next === 0 ? selectedClip.muted : false });
                }}
                style={{ opacity: selectedClip.muted ? 0.4 : 1 }}
              />
              <p className="pbj-studio__range-value">{Math.round(selectedClip.volumePct)}%</p>
            </div>
          )}

          {toolPanel === "crop" && (
            <div className="pbj-studio__volume-panel">
              <span className="pbj-studio__crop-label">Scale</span>
              <input
                type="range"
                className="pbj-studio__range"
                min={MIN_SCALE * 100}
                max={MAX_SCALE * 100}
                step={5}
                value={Math.round(selectedClip.scale * 100)}
                onChange={(e) => updateSelectedClip({ scale: Number(e.target.value) / 100 })}
              />
              <p className="pbj-studio__range-value">{Math.round(selectedClip.scale * 100)}%</p>
            </div>
          )}
        </section>
      )}

      {/* Zone 4a — toolbar, two-level: swaps between a global row (nothing
          selected) and the contextual clip toolkit (clip selected). */}
      <section className="pbj-studio__toolbar">
        {selectedClip ? (
          <div className="pbj-studio__toolbar-row">
            <button type="button" className="pbj-studio__tool-collapse" onClick={deselect} aria-label="Deselect">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M18 15l-6-6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            <button type="button" className="pbj-studio__tool" onClick={performSplit}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <circle cx="6" cy="6" r="3" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="6" cy="18" r="3" stroke="currentColor" strokeWidth="1.8" />
                <path d="M8.5 8L20 19M8.5 16L20 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <span>Split</span>
            </button>

            <button type="button" className="pbj-studio__tool" onClick={openReplace}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 12a8 8 0 0 1 13.6-5.7M20 12a8 8 0 0 1-13.6 5.7"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <path d="M17 3v4h-4M7 21v-4h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Replace</span>
            </button>

            <button
              type="button"
              className={"pbj-studio__tool" + (toolPanel === "speed" ? " pbj-studio__tool--active" : "")}
              onClick={() => setToolPanel((t) => (t === "speed" ? null : "speed"))}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M4 16a8 8 0 1 1 16 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M12 16l4-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <span>Speed</span>
            </button>

            <button
              type="button"
              className={"pbj-studio__tool" + (toolPanel === "text" ? " pbj-studio__tool--active" : "")}
              onClick={() => setToolPanel((t) => (t === "text" ? null : "text"))}
            >
              <span className="pbj-studio__tool-glyph">T</span>
              <span>Text</span>
            </button>

            <button
              type="button"
              className={"pbj-studio__tool" + (toolPanel === "volume" ? " pbj-studio__tool--active" : "")}
              onClick={() => setToolPanel((t) => (t === "volume" ? null : "volume"))}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor" />
                <path d="M16 8.5a5 5 0 0 1 0 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <span>Volume</span>
            </button>

            <button
              type="button"
              className={"pbj-studio__tool" + (toolPanel === "crop" ? " pbj-studio__tool--active" : "")}
              onClick={() => setToolPanel((t) => (t === "crop" ? null : "crop"))}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M7 2v14a2 2 0 0 0 2 2h14M17 22V8a2 2 0 0 0-2-2H2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Crop</span>
            </button>

            <button
              type="button"
              className="pbj-studio__tool pbj-studio__tool--danger"
              onClick={deleteSelectedClip}
              disabled={clips.length <= 1}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Delete</span>
            </button>
          </div>
        ) : (
          <div className="pbj-studio__toolbar-row">
            <button type="button" className="pbj-studio__tool" onClick={() => flashNote("Editing Tools Aren't Set Up Yet")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <circle cx="6" cy="6" r="3" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="6" cy="18" r="3" stroke="currentColor" strokeWidth="1.8" />
                <path d="M8.5 8L20 19M8.5 16L20 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <span>Edit</span>
            </button>
            <button type="button" className="pbj-studio__tool" onClick={() => flashNote("Sound Isn't Set Up Yet")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M9 18V5l11-2v13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="6" cy="18" r="3" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="17" cy="16" r="3" stroke="currentColor" strokeWidth="1.8" />
              </svg>
              <span>Sound</span>
            </button>
            <button type="button" className="pbj-studio__tool" onClick={() => flashNote("Text Isn't Set Up Yet")}>
              <span className="pbj-studio__tool-glyph">Aa</span>
              <span>Text</span>
            </button>
            <button type="button" className="pbj-studio__tool" onClick={() => flashNote("Effects Aren't Set Up Yet")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
              <span>Effects</span>
            </button>
          </div>
        )}
      </section>

      {/* Zone 4b — prompt bar, always present, collapsed to a slim bar
          until tapped. Placeholder scope switches automatically with
          selection. */}
      <section className="pbj-studio__prompt-bar">
        {promptExpanded ? (
          <div className="pbj-studio__prompt-row">
            <textarea
              className="pbj-studio__prompt-input"
              placeholder={selectedClip ? REVISION_PROMPT_PLACEHOLDER_CLIP : REVISION_PROMPT_PLACEHOLDER}
              value={revisionPrompt}
              onChange={(e) => setRevisionPrompt(e.target.value)}
              onBlur={() => {
                if (!revisionPrompt.trim()) setPromptExpanded(false);
              }}
              rows={1}
              autoFocus
            />
            <button type="button" className="pbj-studio__prompt-send" onClick={tapRevisionSend} aria-label="Send revision">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        ) : (
          <button type="button" className="pbj-studio__prompt-collapsed" onClick={() => setPromptExpanded(true)}>
            {revisionPrompt || (selectedClip ? REVISION_PROMPT_PLACEHOLDER_CLIP : REVISION_PROMPT_PLACEHOLDER)}
          </button>
        )}
      </section>
    </div>
  );
}
