import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../types";
import "./ChatPanel.css";

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  isSending: boolean;
  contextLabel?: string | null;
  onClearContext?: () => void;
  /** Bump `nonce` with a new `text` to push a draft into the input (e.g.
   *  from the "Captions" toolbar button) without auto-sending it. */
  inject?: { text: string; nonce: number } | null;
}

const MOCK_DICTATION_CONTEXTUAL = [
  "extend this clip",
  "add text here saying weekend vibes",
  "make this clip shorter",
  "add a caption here saying let's go",
];

const MOCK_DICTATION_GENERIC = [
  "make it punchier",
  "remove the last clip",
  "make the second clip longer",
];

export function ChatPanel({
  messages,
  onSend,
  isSending,
  contextLabel,
  onClearContext,
  inject,
}: ChatPanelProps) {
  const [text, setText] = useState("");
  const [isDictating, setIsDictating] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, isSending]);

  useEffect(() => {
    if (!inject) return;
    setText(inject.text);
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inject?.nonce]);

  const send = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || isSending) return;
    onSend(trimmed);
    setText("");
  };

  const startDictation = () => {
    if (isDictating) return;
    setIsDictating(true);
    const pool = contextLabel ? MOCK_DICTATION_CONTEXTUAL : MOCK_DICTATION_GENERIC;
    const phrase = pool[Math.floor(Math.random() * pool.length)];
    window.setTimeout(() => {
      setText(phrase);
      setIsDictating(false);
    }, 1300);
  };

  return (
    <div className="pbj-chat">
      {contextLabel && (
        <div className="pbj-chat__context">
          <span className="pbj-chat__context-dot" />
          <span className="pbj-chat__context-label">editing at {contextLabel}</span>
          {onClearContext && (
            <button
              type="button"
              className="pbj-chat__context-clear"
              onClick={onClearContext}
              aria-label="Clear context"
            >
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      )}

      {messages.length > 0 && (
        <div className="pbj-chat__list" ref={listRef}>
          {messages.map((m) => (
            <div key={m.id} className={`pbj-chat__msg pbj-chat__msg--${m.role}`}>
              {m.text}
            </div>
          ))}
          {isSending && (
            <div className="pbj-chat__msg pbj-chat__msg--assistant pbj-chat__msg--typing">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      )}

      <form
        className="pbj-chat__form"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <button
          type="button"
          className={"pbj-chat__mic" + (isDictating ? " pbj-chat__mic--active" : "")}
          onClick={startDictation}
          disabled={isDictating}
          aria-label="Dictate"
        >
          {isDictating ? (
            <span className="pbj-chat__mic-pulse" />
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
              <path
                d="M5 11a7 7 0 0 0 14 0M12 18v3"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
        <input
          ref={inputRef}
          className="pbj-chat__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={isDictating ? "listening…" : "e.g. remove clip 3, make clip 2 longer…"}
          enterKeyHint="send"
        />
        <button
          type="submit"
          className="pbj-chat__send"
          disabled={!text.trim() || isSending}
          aria-label="Send"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 12L20 4L13 20L11 13L4 12Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </form>
    </div>
  );
}
