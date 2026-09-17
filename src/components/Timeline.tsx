import { useMemo, useRef } from "react";
import type { EditPlan, TransitionType } from "../types";
import "./Timeline.css";

const TRANSITION_LABEL: Record<TransitionType, string> = {
  cut: "Cut",
  crossfade: "Fade",
  "whip-pan": "Whip",
  zoom: "Zoom",
  slide: "Slide",
};

const PX_PER_SEC = 26;
const MIN_CLIP_WIDTH = 46;
const TRANSITION_WIDTH = 22;

interface ClipLayout {
  id: string;
  leftPx: number;
  widthPx: number;
  startSec: number;
  endSec: number;
}

interface TimelineProps {
  plan: EditPlan;
  selectedClipId: string | null;
  onSelectClip: (clipId: string) => void;
  currentTimeSec?: number;
  onScrub?: (timeSec: number) => void;
  onAddClip?: () => void;
}

function tickStepFor(totalSec: number): number {
  if (totalSec <= 20) return 5;
  if (totalSec <= 60) return 10;
  if (totalSec <= 180) return 30;
  return 60;
}

function formatTick(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}:${s.toString().padStart(2, "0")}`;
}

export function Timeline({
  plan,
  selectedClipId,
  onSelectClip,
  currentTimeSec,
  onScrub,
  onAddClip,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const totalSec = plan.clips.length
    ? plan.clips[plan.clips.length - 1].endSec
    : 0;

  const layout = useMemo<ClipLayout[]>(() => {
    let cursor = 0;
    return plan.clips.map((clip, i) => {
      const len = clip.endSec - clip.startSec;
      const widthPx = Math.max(MIN_CLIP_WIDTH, len * PX_PER_SEC);
      if (i > 0) cursor += TRANSITION_WIDTH;
      const leftPx = cursor;
      cursor += widthPx;
      return { id: clip.id, leftPx, widthPx, startSec: clip.startSec, endSec: clip.endSec };
    });
  }, [plan.clips]);

  const secToPx = (t: number): number => {
    for (const item of layout) {
      const len = item.endSec - item.startSec;
      if (t >= item.startSec && t <= item.endSec) {
        const frac = len > 0 ? (t - item.startSec) / len : 0;
        return item.leftPx + frac * item.widthPx;
      }
    }
    if (layout.length === 0) return 0;
    return t < layout[0].startSec ? 0 : layout[layout.length - 1].leftPx + layout[layout.length - 1].widthPx;
  };

  const playheadPx = useMemo(() => {
    if (currentTimeSec == null || layout.length === 0) return null;
    const t = Math.max(0, Math.min(totalSec, currentTimeSec));
    return secToPx(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTimeSec, layout, totalSec]);

  const ticks = useMemo(() => {
    if (layout.length === 0) return [];
    const step = tickStepFor(totalSec);
    const result: { sec: number; px: number }[] = [];
    for (let t = 0; t <= totalSec; t += step) {
      result.push({ sec: t, px: secToPx(t) });
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, totalSec]);

  const handleScrub = (clientX: number) => {
    const track = trackRef.current;
    if (!track || !onScrub || layout.length === 0) return;
    const rect = track.getBoundingClientRect();
    const x = clientX - rect.left + track.scrollLeft;

    for (const item of layout) {
      if (x >= item.leftPx && x <= item.leftPx + item.widthPx) {
        const frac = item.widthPx > 0 ? (x - item.leftPx) / item.widthPx : 0;
        const len = item.endSec - item.startSec;
        onScrub(Math.max(0, item.startSec + frac * len));
        return;
      }
    }
    const last = layout[layout.length - 1];
    onScrub(x < layout[0].leftPx ? 0 : last.endSec);
  };

  return (
    <div className="pbj-timeline">
      <div className="pbj-timeline__meta">
        <span>{plan.clips.length} clips</span>
        <span>·</span>
        <span>{Math.round(totalSec)}s total</span>
        <span>·</span>
        <span className="pbj-timeline__pacing">{plan.pacing} pacing</span>
      </div>

      <div className="pbj-timeline__scroll">
        <div
          className="pbj-timeline__track"
          ref={trackRef}
          onClick={(e) => handleScrub(e.clientX)}
        >
          {playheadPx != null && (
              <div className="pbj-timeline__playhead" style={{ left: playheadPx }} />
            )}

            {ticks.map((tick) => (
              <div className="pbj-timeline__tick" key={tick.sec} style={{ left: tick.px }}>
                <span className="pbj-timeline__tick-mark" />
                <span className="pbj-timeline__tick-label">{formatTick(tick.sec)}</span>
              </div>
            ))}

            {plan.clips.map((clip, i) => {
              const len = clip.endSec - clip.startSec;
              const width = Math.max(MIN_CLIP_WIDTH, len * PX_PER_SEC);
              const selected = clip.id === selectedClipId;

              return (
                <div className="pbj-timeline__item" key={clip.id}>
                  {i > 0 && (
                    <div
                      className="pbj-timeline__transition"
                      title={TRANSITION_LABEL[clip.transitionIn]}
                    >
                      <span>{TRANSITION_LABEL[clip.transitionIn]}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    className={
                      "pbj-timeline__clip" + (selected ? " pbj-timeline__clip--selected" : "")
                    }
                    style={{ width, background: clip.thumbColor }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectClip(clip.id);
                    }}
                  >
                    <span className="pbj-timeline__badges">
                      {clip.speedMultiplier !== 1 && (
                        <span className="pbj-timeline__badge" title="Playback speed">
                          {clip.speedMultiplier}x
                        </span>
                      )}
                      {clip.muted && (
                        <span className="pbj-timeline__badge pbj-timeline__badge--icon" title="Muted">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
                            <path
                              d="M3 3l18 18M9 9v3a3 3 0 0 0 4.6 2.55M15 9.34V6a3 3 0 0 0-5.6-1.48M5 10v2a7 7 0 0 0 10.24 6.2M12 18v3"
                              stroke="white"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </span>
                      )}
                    </span>
                    {clip.overlays.length > 0 && (
                      <span className="pbj-timeline__cc-badge" aria-label="Has caption">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="white">
                          <path d="M3 5h18v14H3z" opacity="0" />
                          <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7zm4 4.5h2.2v.9a1.4 1.4 0 1 1 0 2.2v.9H8a2.5 2.5 0 0 1 0-4zm6.4 0h2.2v.9a1.4 1.4 0 1 1 0 2.2v.9h-2.2a2.5 2.5 0 0 1 0-4z" />
                        </svg>
                      </span>
                    )}
                    <span className="pbj-timeline__clip-label">{clip.label}</span>
                    <span className="pbj-timeline__clip-len">{len.toFixed(1)}s</span>
                  </button>
                </div>
              );
            })}

            {onAddClip && (
              <button
                type="button"
                className="pbj-timeline__add-clip"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddClip();
                }}
                aria-label="Add clip"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 5v14M5 12h14"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
        </div>
      </div>
    </div>
  );
}
