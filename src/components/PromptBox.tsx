import "./PromptBox.css";

interface PromptBoxProps {
  value: string;
  onChange: (value: string) => void;
}

export function PromptBox({ value, onChange }: PromptBoxProps) {
  return (
    <div className="pbj-promptbox">
      <textarea
        className="pbj-promptbox__input"
        placeholder="Describe the Edit You Want…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
      />
    </div>
  );
}
