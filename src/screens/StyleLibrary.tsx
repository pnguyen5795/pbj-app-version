import { useEffect, useRef, useState } from "react";
import type { MediaKind, SavedStyle } from "../types";
import { TopBar } from "../components/TopBar";
import { Button } from "../components/Button";
import { styleLibraryService } from "../services";
import "./StyleLibrary.css";

interface PendingUpload {
  fileName: string;
  previewUrl: string;
  kind: MediaKind;
}

export function StyleLibrary({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<SavedStyle[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    styleLibraryService.list().then((list) => {
      setItems(list);
      setLoading(false);
    });
  }, []);

  const handleFile = (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    const previewUrl = URL.createObjectURL(file);
    const kind: MediaKind = file.type.startsWith("video/") ? "video" : "photo";
    const fileName = file.name.replace(/\.[a-z0-9]+$/i, "");
    setPending({ fileName, previewUrl, kind });
    setNameInput(fileName);
  };

  const cancelPending = () => {
    if (pending) URL.revokeObjectURL(pending.previewUrl);
    setPending(null);
    setNameInput("");
  };

  const savePending = async () => {
    if (!pending) return;
    setSaving(true);
    try {
      const saved = await styleLibraryService.add(pending, nameInput);
      setItems((prev) => [saved, ...prev]);
      setPending(null);
      setNameInput("");
    } finally {
      setSaving(false);
    }
  };

  const removeItem = async (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    await styleLibraryService.remove(id);
  };

  return (
    <div className="pbj-style-lib">
      <TopBar onBack={onBack} />

      <div className="pbj-style-lib__body">
        <div className="pbj-style-lib__hero">
          <h1 className="pbj-style-lib__title">style library</h1>
          <p className="pbj-style-lib__sub">
            save reference clips — your own past edits, or other creators' content — so the
            AI can match their style later
          </p>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="video/*,image/*"
          className="pbj-style-lib__input"
          onChange={(e) => {
            handleFile(e.target.files);
            e.target.value = "";
          }}
        />

        {pending ? (
          <div className="pbj-style-lib__composer">
            <div className="pbj-style-lib__composer-preview">
              {pending.kind === "video" ? (
                <video src={pending.previewUrl} muted playsInline />
              ) : (
                <img src={pending.previewUrl} alt="" />
              )}
            </div>
            <div className="pbj-style-lib__composer-fields">
              <input
                type="text"
                className="pbj-style-lib__name-input"
                placeholder="name this style…"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                autoFocus
              />
              <div className="pbj-style-lib__composer-actions">
                <Button variant="secondary" onClick={cancelPending} disabled={saving}>
                  cancel
                </Button>
                <Button onClick={savePending} disabled={saving || !nameInput.trim()}>
                  {saving ? "saving…" : "save to library"}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="pbj-style-lib__add"
            onClick={() => inputRef.current?.click()}
          >
            <span className="pbj-style-lib__add-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
            add a style clip
          </button>
        )}

        {!loading && items.length > 0 && (
          <div className="pbj-style-lib__grid">
            {items.map((item) => (
              <div className="pbj-style-lib__card" key={item.id}>
                <div
                  className="pbj-style-lib__thumb"
                  style={!item.previewUrl ? { background: item.thumbColor } : undefined}
                >
                  {item.previewUrl &&
                    (item.kind === "video" ? (
                      <video src={item.previewUrl} muted playsInline />
                    ) : (
                      <img src={item.previewUrl} alt="" />
                    ))}
                  <button
                    type="button"
                    className="pbj-style-lib__remove"
                    onClick={() => removeItem(item.id)}
                    aria-label="Remove"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M1 1L9 9M9 1L1 9" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
                <span className="pbj-style-lib__card-name">{item.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
