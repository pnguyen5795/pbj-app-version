import "./StyleReferenceSection.css";

interface StyleReferenceSectionProps {
  url: string;
  onUrlChange: (url: string) => void;
}

export function StyleReferenceSection({ url, onUrlChange }: StyleReferenceSectionProps) {
  return (
    <div className="pbj-style-ref">
      <p className="pbj-style-ref__hint">
        paste a link to a reference video — in addition to describing the vibe above
      </p>

      <input
        type="url"
        inputMode="url"
        className="pbj-style-ref__input"
        placeholder="Paste a Reference Video Link…"
        value={url}
        onChange={(e) => onUrlChange(e.target.value)}
      />
    </div>
  );
}
