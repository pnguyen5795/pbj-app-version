import { useEffect, useRef, useState } from "react";
import { formatTimestamp } from "../utils/format";
import "./VideoPlayer.css";

interface VideoPlayerProps {
  src: string;
  posterUrl?: string;
  /** External seek target (e.g. from scrubbing the timeline). */
  seekToSec?: number | null;
  /** Fired when playback pauses (including a tap-to-pause), reporting the
   *  moment the user is now looking at — used to give chat edits context. */
  onPause?: (timeSec: number) => void;
}

export function VideoPlayer({ src, posterUrl, seekToSec, onPause }: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const lastAppliedSeek = useRef<number | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || seekToSec == null) return;
    if (lastAppliedSeek.current === seekToSec) return;
    lastAppliedSeek.current = seekToSec;
    video.currentTime = seekToSec;
    setCurrentTime(seekToSec);
  }, [seekToSec]);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen?.();
    }
  };

  return (
    <div className="pbj-player" ref={containerRef}>
      {src ? (
        <video
          ref={videoRef}
          src={src}
          className="pbj-player__video"
          playsInline
          loop
          onClick={toggle}
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={() => setDuration(videoRef.current?.duration ?? 0)}
          onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
          onPause={() => onPause?.(videoRef.current?.currentTime ?? 0)}
        />
      ) : posterUrl ? (
        <img src={posterUrl} className="pbj-player__video" alt="" />
      ) : (
        <div className="pbj-player__placeholder">
          <span>Preview</span>
        </div>
      )}

      {src && !playing && (
        <button className="pbj-player__play" onClick={toggle} aria-label="Play">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="white">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
      )}

      {src && (
        <div className="pbj-player__controls">
          <button
            type="button"
            className="pbj-player__control-btn"
            onClick={toggle}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="white">
                <rect x="5" y="4" width="5" height="16" rx="1.5" />
                <rect x="14" y="4" width="5" height="16" rx="1.5" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="white">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <span className="pbj-player__time">
            {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
          </span>

          <button
            type="button"
            className="pbj-player__control-btn"
            onClick={toggleFullscreen}
            aria-label="Fullscreen"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"
                stroke="white"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
