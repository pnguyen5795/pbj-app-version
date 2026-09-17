import { useRef, useState } from "react";
import type { ChatMessage, EditPlan, ProjectResult, TimelineClip } from "../types";
import { TopBar } from "../components/TopBar";
import { VideoPlayer } from "../components/VideoPlayer";
import { Timeline } from "../components/Timeline";
import { ChatPanel } from "../components/ChatPanel";
import { ExportSheet } from "../components/ExportSheet";
import { ReasoningSheet } from "../components/ReasoningSheet";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { chatEditService, exportService, renderService } from "../services";
import { makeId } from "../utils/id";
import { CLIP_COLORS } from "../services/mock/mockEditPlan";
import { PRESET_STYLES } from "../data/presetStyles";
import "./Results.css";

interface ResultsProps {
  result: ProjectResult;
  onResultChange: (result: ProjectResult) => void;
  onStartOver: () => void;
  onDiscardAndRestart: () => void;
}

const TRANSITION_OPTIONS = [
  { label: "Cut", emoji: "✂️" },
  { label: "Fade", emoji: "🌫️" },
  { label: "Whip", emoji: "💫" },
  { label: "Zoom", emoji: "🔍" },
  { label: "Slide", emoji: "➡️" },
];

function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function appendMockClip(plan: EditPlan): EditPlan {
  const newClip: TimelineClip = {
    id: makeId("clip"),
    sourceAssetId: makeId("asset"),
    label: `Clip ${plan.clips.length + 1}`,
    thumbColor: CLIP_COLORS[plan.clips.length % CLIP_COLORS.length],
    startSec: 0,
    endSec: 0,
    transitionIn: "cut",
    overlays: [],
    sourceInSec: 0,
    sourceOutSec: 3,
    speedMultiplier: 1,
    muted: false,
  };
  const clips = [...plan.clips, newClip];
  let cursor = 0;
  const retimed = clips.map((c) => {
    const len = c.id === newClip.id ? 3 : c.endSec - c.startSec;
    const startSec = cursor;
    const endSec = cursor + len;
    cursor = endSec;
    return { ...c, startSec, endSec };
  });
  return { ...plan, clips: retimed, targetDurationSec: Math.round(cursor) };
}

export function Results({
  result,
  onResultChange,
  onStartOver,
  onDiscardAndRestart,
}: ResultsProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(
    result.plan.clips[0]?.id ?? null
  );
  const [exportOpen, setExportOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [warningsDismissed, setWarningsDismissed] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState<number | null>(null);
  const [seekToSec, setSeekToSec] = useState<number | null>(null);
  const [toolbarPicker, setToolbarPicker] = useState<"style" | "transitions" | null>(null);
  const [inject, setInject] = useState<{ text: string; nonce: number } | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  // The orchestrator already rendered history[0] before landing here, so
  // that's the index result.videoUrl currently matches. Any undo/redo/edit
  // that moves away from the last-rendered index means the preview is
  // stale until "render" is pressed again — tracked as a comparison
  // rather than a separate flag so it can't drift out of sync.
  const [renderedHistoryIndex, setRenderedHistoryIndex] = useState(0);

  const [history, setHistory] = useState<EditPlan[]>([result.plan]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const injectNonce = useRef(0);
  const plan = history[historyIndex];
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const pushPlan = (newPlan: EditPlan) => {
    const next = history.slice(0, historyIndex + 1).concat([newPlan]);
    setHistory(next);
    setHistoryIndex(next.length - 1);
    onResultChange({ ...result, plan: newPlan });
  };

  const isDirty = historyIndex !== renderedHistoryIndex;

  const handleRender = async () => {
    setIsRendering(true);
    setRenderError(null);
    try {
      const { videoUrl } = await renderService.render(plan);
      onResultChange({ ...result, videoUrl, plan });
      setRenderedHistoryIndex(historyIndex);
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : "Render failed.");
    } finally {
      setIsRendering(false);
    }
  };

  const undo = () => {
    if (!canUndo) return;
    const idx = historyIndex - 1;
    setHistoryIndex(idx);
    onResultChange({ ...result, plan: history[idx] });
  };

  const redo = () => {
    if (!canRedo) return;
    const idx = historyIndex + 1;
    setHistoryIndex(idx);
    onResultChange({ ...result, plan: history[idx] });
  };

  const activeClip = plan.clips.find((c) => c.id === selectedClipId);
  const hasContext = currentTimeSec != null;
  const contextLabel = hasContext
    ? `${formatTime(currentTimeSec!)}${activeClip ? ` · ${activeClip.label}` : ""}`
    : null;

  const setContextFromTime = (t: number) => {
    setCurrentTimeSec(t);
    const clip = plan.clips.find((c) => t >= c.startSec && t < c.endSec);
    if (clip) setSelectedClipId(clip.id);
  };

  const handleSelectClip = (clipId: string) => {
    setSelectedClipId(clipId);
    const clip = plan.clips.find((c) => c.id === clipId);
    if (clip) {
      setCurrentTimeSec(clip.startSec);
      setSeekToSec(clip.startSec);
    }
  };

  const handleScrub = (t: number) => {
    setContextFromTime(t);
    setSeekToSec(t);
  };

  const handleSend = async (text: string) => {
    const userMsg: ChatMessage = {
      id: makeId("msg"),
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsSending(true);

    try {
      const { plan: nextPlan, assistantReply } = await chatEditService.applyInstruction(
        plan,
        text,
        messages,
        selectedClipId
      );

      pushPlan(nextPlan);
      if (!nextPlan.clips.some((c) => c.id === selectedClipId)) {
        setSelectedClipId(nextPlan.clips[0]?.id ?? null);
      }

      const assistantMsg: ChatMessage = {
        id: makeId("msg"),
        role: "assistant",
        text: assistantReply,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } finally {
      setIsSending(false);
    }
  };

  const handleAddClip = () => {
    pushPlan(appendMockClip(plan));
  };

  const openCaptionsDraft = () => {
    injectNonce.current += 1;
    setInject({ text: "add text overlay saying ", nonce: injectNonce.current });
    setToolbarPicker(null);
  };

  // Session-level warnings (e.g. a clip Twelve Labs couldn't analyze)
  // plus the current plan's own warnings (e.g. not enough footage to hit
  // the target) — both need to stay visible rather than being buried in
  // editorialNotes text nothing displays, which is what the stress test found.
  const allWarnings = [...(result.warnings ?? []), ...(plan.warnings ?? [])];

  return (
    <div className="pbj-results">
      <TopBar
        title="your edit"
        onBack={onStartOver}
        right={
          <button className="pbj-results__export-btn" onClick={() => setExportOpen(true)}>
            export
          </button>
        }
      />

      <div className="pbj-results__player-wrap">
        <VideoPlayer
          src={result.videoUrl}
          posterUrl={result.posterUrl}
          seekToSec={seekToSec}
          onPause={(t) => setContextFromTime(t)}
        />
      </div>

      {renderError && <p className="pbj-results__render-error">{renderError}</p>}

      {allWarnings.length > 0 && !warningsDismissed && (
        <div className="pbj-results__warning-banner">
          <div className="pbj-results__warning-list">
            {allWarnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </div>
          <button
            type="button"
            className="pbj-results__warning-dismiss"
            onClick={() => setWarningsDismissed(true)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      <div className="pbj-results__timeline-head">
        <span className="pbj-results__timeline-title">timeline</span>
        <div className="pbj-results__timeline-actions">
          <button
            type="button"
            className={
              "pbj-results__render-btn" + (isDirty ? " pbj-results__render-btn--dirty" : "")
            }
            onClick={handleRender}
            disabled={isRendering}
          >
            {isRendering ? "rendering…" : isDirty ? "render changes" : "rendered ✓"}
          </button>
          <button
            type="button"
            className="pbj-results__icon-btn"
            onClick={undo}
            disabled={!canUndo}
            aria-label="Undo"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path
                d="M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-1"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="pbj-results__icon-btn"
            onClick={redo}
            disabled={!canRedo}
            aria-label="Redo"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path
                d="M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10h1"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="pbj-results__redo-btn"
            onClick={() => setDiscardConfirmOpen(true)}
          >
            start over
          </button>
        </div>
      </div>

      <Timeline
        plan={plan}
        selectedClipId={selectedClipId}
        onSelectClip={handleSelectClip}
        currentTimeSec={currentTimeSec ?? undefined}
        onScrub={handleScrub}
        onAddClip={handleAddClip}
      />

      <div className="pbj-results__toolbar">
        <button type="button" className="pbj-results__tool" onClick={openCaptionsDraft}>
          <span className="pbj-results__tool-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <path d="M7 15h4M13 15h4M7 10h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
          captions
        </button>
        <button
          type="button"
          className="pbj-results__tool"
          onClick={() => setToolbarPicker(toolbarPicker === "style" ? null : "style")}
        >
          <span className="pbj-results__tool-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 3l2.5 5.5L20 10l-4.5 3.8L17 20l-5-3.2L7 20l1.5-6.2L4 10l5.5-1.5L12 3z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          style
        </button>
        <button
          type="button"
          className="pbj-results__tool"
          onClick={() => setToolbarPicker(toolbarPicker === "transitions" ? null : "transitions")}
        >
          <span className="pbj-results__tool-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 7h9l-3-3M20 17H11l3 3"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          transitions
        </button>
        <button type="button" className="pbj-results__tool" onClick={() => setReasoningOpen(true)}>
          <span className="pbj-results__tool-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
              <path d="M12 11v5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <circle cx="12" cy="7.75" r="1.1" fill="currentColor" />
            </svg>
          </span>
          why this edit
        </button>
      </div>

      {toolbarPicker && (
        <div className="pbj-results__tool-picker">
          {(toolbarPicker === "style"
            ? PRESET_STYLES.map((p) => ({ key: p.id, emoji: p.emoji, label: p.name }))
            : TRANSITION_OPTIONS.map((t) => ({ key: t.label, emoji: t.emoji, label: t.label }))
          ).map((opt) => (
            <button
              key={opt.key}
              type="button"
              className="pbj-results__tool-chip"
              onClick={() => {
                if (toolbarPicker === "style") {
                  handleSend(`Apply the ${opt.label} style throughout`);
                } else {
                  handleSend(`Use ${opt.label} transitions between clips`);
                }
                setToolbarPicker(null);
              }}
            >
              <span className="pbj-results__tool-chip-emoji">{opt.emoji}</span>
              {opt.label}
            </button>
          ))}
        </div>
      )}

      <ChatPanel
        messages={messages}
        onSend={handleSend}
        isSending={isSending}
        contextLabel={contextLabel}
        onClearContext={() => setCurrentTimeSec(null)}
        inject={inject}
      />

      <ExportSheet
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        onExport={(options) => exportService.export(plan, options)}
      />

      <ReasoningSheet open={reasoningOpen} onClose={() => setReasoningOpen(false)} plan={plan} />

      <ConfirmDialog
        open={discardConfirmOpen}
        title="start over?"
        message="Are you sure? This will discard your current edit."
        confirmLabel="discard"
        cancelLabel="keep editing"
        onCancel={() => setDiscardConfirmOpen(false)}
        onConfirm={() => {
          setDiscardConfirmOpen(false);
          onDiscardAndRestart();
        }}
      />
    </div>
  );
}
