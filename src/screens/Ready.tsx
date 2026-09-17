import { useEffect, useState } from "react";
import type { ProjectResult } from "../types";
import { Button } from "../components/Button";
import { ConfettiCelebration } from "../components/ConfettiCelebration";
import "./Ready.css";

function formatStampDate(d: Date): string {
  const day = d.getDate();
  const month = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

export function Ready({
  result,
  onContinue,
}: {
  result: ProjectResult;
  onContinue: () => void;
}) {
  const [confettiOn, setConfettiOn] = useState(false);

  useEffect(() => {
    // Trigger after mount so the CSS animation actually plays on entry.
    const id = requestAnimationFrame(() => setConfettiOn(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const clipCount = result.plan.clips.length;
  const totalSec = Math.round(result.plan.targetDurationSec);
  const dateStr = formatStampDate(new Date());
  const shortId = result.plan.id.slice(-6).toUpperCase();
  const firstClipColor = result.plan.clips[0]?.thumbColor ?? "var(--pbj-accent)";

  return (
    <div className="pbj-ready">
      <ConfettiCelebration show={confettiOn} />

      <div className="pbj-ready__body">
        <div className="pbj-ready__card-zone">
          <div className="pbj-ready__card">
            <span className="pbj-ready__decor pbj-ready__decor--tl">🎬</span>
            <span className="pbj-ready__decor pbj-ready__decor--tr">✨</span>
            <span className="pbj-ready__decor pbj-ready__decor--bl">🎞️</span>
            <span className="pbj-ready__decor pbj-ready__decor--br">📹</span>

            <span className="pbj-ready__card-label">PB&J</span>

            <div className="pbj-ready__thumb" style={{ background: firstClipColor }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="white">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>

            <p className="pbj-ready__identity">
              {clipCount} clip{clipCount === 1 ? "" : "s"} · {totalSec}s
            </p>

            <div className="pbj-ready__stamp">
              <span className="pbj-ready__stamp-word">ready</span>
              <span className="pbj-ready__stamp-date">{dateStr}</span>
            </div>

            <span className="pbj-ready__pacing-badge">🎬 {result.plan.pacing} pacing</span>

            <div className="pbj-ready__card-footer">
              <span>ISSUED: {dateStr}</span>
              <span>NO. {shortId}</span>
            </div>
          </div>
        </div>

        <div className="pbj-ready__headline">
          <h1 className="pbj-ready__title">your edit is ready 🎉</h1>
          <p className="pbj-ready__sub">you're all set — take a look.</p>
        </div>
      </div>

      <div className="pbj-ready__footer">
        <Button fullWidth onClick={onContinue}>
          continue
        </Button>
      </div>
    </div>
  );
}
