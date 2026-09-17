import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MediaAsset } from "../types";
import {
  startMediaUpload,
  getUnmergedCompletedUploadAssets,
  markUploadsMerged,
  subscribeMediaUploads,
  getMediaUploadsSnapshot,
  totalPendingUploadCount,
} from "../state/mediaUploadStore";
import "./MediaPicker.css";

interface MediaPickerProps {
  assets: MediaAsset[];
  onChange: (assets: MediaAsset[] | ((prev: MediaAsset[]) => MediaAsset[])) => void;
}

export function MediaPicker({ assets, onChange }: MediaPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const uploadRuns = useSyncExternalStore(subscribeMediaUploads, getMediaUploadsSnapshot);
  const uploading = totalPendingUploadCount() > 0;

  useEffect(() => {
    // "Merged" is tracked in the store itself, not a local ref — the
    // actual upload work lives in mediaUploadStore so it survives this
    // component unmounting (e.g. the creator navigates away from Setup
    // mid-upload, or Setup remounts after a failed generate attempt). A
    // component-local ref would reset on that remount and re-merge every
    // already-completed upload a second time, doubling the asset list.
    const fresh = getUnmergedCompletedUploadAssets();
    if (fresh.length === 0) return;
    markUploadsMerged(fresh.map((f) => f.itemId));
    // Functional update, not a snapshot of the `assets` prop — several
    // uploads can complete in quick succession (concurrency 4), and
    // reading a possibly-stale `assets` closure here could silently drop
    // one if two completions land before a re-render flushes.
    onChange((prev) => [...prev, ...fresh.map((f) => f.asset)]);
  }, [uploadRuns, onChange]);

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    // Real upload to the shared backend — works the same whether this is
    // your machine or a friend's phone on the same WiFi, since both are
    // just POSTing to whatever host served this page. Starts immediately,
    // concurrently, and keeps running even if this screen is left.
    startMediaUpload(Array.from(fileList));
  };

  const removeAsset = (id: string) => {
    onChange(assets.filter((a) => a.id !== id));
  };

  return (
    <div className="pbj-picker">
      <input
        ref={inputRef}
        type="file"
        accept="video/*,image/*"
        multiple
        className="pbj-picker__input"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {error && <p className="pbj-picker__error">{error}</p>}

      {assets.length === 0 && !uploading ? (
        <button
          type="button"
          className="pbj-picker__empty"
          onClick={() => inputRef.current?.click()}
        >
          <div className="pbj-picker__empty-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="5" width="18" height="15" rx="3" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="8.5" cy="10.5" r="1.5" fill="currentColor" />
              <path
                d="M4 17l4.5-4.5a2 2 0 0 1 2.8 0L16 17M14.5 15.5l1.2-1.2a2 2 0 0 1 2.8 0L21 17"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <span className="pbj-picker__empty-title">Tap to Add Photos & Videos</span>
          <span className="pbj-picker__empty-sub">From Your Library</span>
        </button>
      ) : assets.length === 0 && uploading ? (
        <div className="pbj-picker__empty">
          <div className="pbj-picker__empty-icon">
            <span className="pbj-picker__spinner" />
          </div>
          <span className="pbj-picker__empty-title">Uploading…</span>
          <span className="pbj-picker__empty-sub">Feel Free to Keep Going — This Keeps Running in the Background</span>
        </div>
      ) : (
        <>
          <div className="pbj-picker__grid">
            {assets.map((asset) => (
              <div className="pbj-picker__tile" key={asset.id}>
                {asset.kind === "video" ? (
                  <video src={asset.previewUrl} muted playsInline className="pbj-picker__media" />
                ) : (
                  <img src={asset.previewUrl} className="pbj-picker__media" alt="" />
                )}
                {asset.kind === "video" && (
                  <span className="pbj-picker__badge">
                    {Math.round(asset.durationSec)}s
                  </span>
                )}
                <button
                  type="button"
                  className="pbj-picker__remove"
                  onClick={() => removeAsset(asset.id)}
                  aria-label="Remove"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path
                      d="M1 1L9 9M9 1L1 9"
                      stroke="white"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            ))}
            <button
              type="button"
              className="pbj-picker__add-tile"
              onClick={() => inputRef.current?.click()}
              aria-label="Add more"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
          <p className="pbj-picker__count">
            {assets.length} Item{assets.length === 1 ? "" : "s"} Ready
            {uploading ? ` — more uploading in the background…` : ""}
          </p>
        </>
      )}
    </div>
  );
}
