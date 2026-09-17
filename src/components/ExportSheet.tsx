import { useState } from "react";
import type { AspectRatio, ExportOptions, ExportResolution } from "../types";
import { Button } from "./Button";
import "./ExportSheet.css";

const ASPECT_OPTIONS: { value: AspectRatio; label: string; emoji: string }[] = [
  { value: "9:16", label: "9:16 Reels/TikTok", emoji: "📱" },
  { value: "4:5", label: "4:5 Feed", emoji: "🖼️" },
  { value: "1:1", label: "1:1 Square", emoji: "⬜" },
  { value: "16:9", label: "16:9 Widescreen", emoji: "🖥️" },
];

const RES_OPTIONS: ExportResolution[] = ["720p", "1080p", "4K"];

interface ExportSheetProps {
  open: boolean;
  onClose: () => void;
  onExport: (options: ExportOptions) => Promise<{ fileName: string; savedToLibrary?: boolean }>;
}

type Phase = "options" | "exporting" | "done" | "error";

export function ExportSheet({ open, onClose, onExport }: ExportSheetProps) {
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [resolution, setResolution] = useState<ExportResolution>("1080p");
  const [phase, setPhase] = useState<Phase>("options");
  const [savedFile, setSavedFile] = useState("");
  const [savedToLibrary, setSavedToLibrary] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  if (!open) return null;

  const handleExport = async () => {
    setPhase("exporting");
    try {
      const result = await onExport({ aspectRatio, resolution });
      setSavedFile(result.fileName);
      setSavedToLibrary(result.savedToLibrary ?? true);
      setPhase("done");
    } catch (err) {
      // Found live: an uncaught rejection here (e.g. the Web Share sheet
      // throwing) used to leave this stuck on the spinner forever with no
      // way out except closing the app. Always land somewhere visible.
      setErrorMessage(err instanceof Error ? err.message : "Export failed.");
      setPhase("error");
    }
  };

  const handleClose = () => {
    onClose();
    setTimeout(() => setPhase("options"), 300);
  };

  return (
    <div className="pbj-sheet-backdrop" onClick={phase === "options" ? handleClose : undefined}>
      <div className="pbj-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="pbj-sheet__handle" />

        {phase === "options" && (
          <>
            <h2 className="pbj-sheet__title">export your edit</h2>
            <p className="pbj-sheet__subtitle">choose a format to save to your library</p>

            <div className="pbj-sheet__group">
              <span className="pbj-sheet__label">aspect ratio</span>
              <div className="pbj-sheet__options">
                {ASPECT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    className={
                      "pbj-sheet__option" +
                      (aspectRatio === opt.value ? " pbj-sheet__option--selected" : "")
                    }
                    onClick={() => setAspectRatio(opt.value)}
                  >
                    <span className="pbj-sheet__option-emoji">{opt.emoji}</span>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="pbj-sheet__group">
              <span className="pbj-sheet__label">resolution</span>
              <div className="pbj-sheet__options">
                {RES_OPTIONS.map((res) => (
                  <button
                    key={res}
                    className={
                      "pbj-sheet__option" +
                      (resolution === res ? " pbj-sheet__option--selected" : "")
                    }
                    onClick={() => setResolution(res)}
                  >
                    {res}
                  </button>
                ))}
              </div>
            </div>

            <Button fullWidth onClick={handleExport}>
              export ✨
            </Button>
          </>
        )}

        {phase === "exporting" && (
          <div className="pbj-sheet__status">
            <div className="pbj-sheet__spinner" />
            <p>Saving to Your Photo Library…</p>
          </div>
        )}

        {phase === "done" && (
          <div className="pbj-sheet__status">
            <div className="pbj-sheet__check">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 12.5l5 5L20 6.5"
                  stroke="white"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <p className="pbj-sheet__status-title">
              {savedToLibrary ? "check your share sheet 🎉" : "downloaded 🎉"}
            </p>
            <p className="pbj-sheet__status-sub">
              {savedToLibrary
                ? `choose "Save Video" to add ${savedFile} to your library`
                : `${savedFile} saved to your downloads`}
            </p>
            <Button fullWidth variant="secondary" onClick={handleClose}>
              done
            </Button>
          </div>
        )}

        {phase === "error" && (
          <div className="pbj-sheet__status">
            <p className="pbj-sheet__status-title">export failed</p>
            <p className="pbj-sheet__status-sub">{errorMessage}</p>
            <Button fullWidth onClick={() => setPhase("options")}>
              try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
