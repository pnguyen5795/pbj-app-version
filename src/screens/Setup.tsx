import type { MediaAsset } from "../types";
import { TopBar } from "../components/TopBar";
import { MediaPicker } from "../components/MediaPicker";
import { DurationSlider } from "../components/DurationSlider";
import { PromptBox } from "../components/PromptBox";
import { StyleReferenceSection } from "../components/StyleReferenceSection";
import { Button } from "../components/Button";
import "./Setup.css";

function SectionLabel({ title, badge }: { title: string; badge?: string }) {
  return (
    <div className="pbj-setup__label-row">
      <span className="pbj-setup__label-title">{title}</span>
      {badge && <span className="pbj-setup__label-badge">{badge}</span>}
    </div>
  );
}

interface SetupProps {
  assets: MediaAsset[];
  targetDurationSec: number;
  prompt: string;
  styleReferenceUrl: string;
  onAssetsChange: (assets: MediaAsset[] | ((prev: MediaAsset[]) => MediaAsset[])) => void;
  onDurationChange: (sec: number) => void;
  onPromptChange: (prompt: string) => void;
  onStyleReferenceUrlChange: (url: string) => void;
  onSubmit: () => void;
  onExitToLanding: () => void;
}

export function Setup({
  assets,
  targetDurationSec,
  prompt,
  styleReferenceUrl,
  onAssetsChange,
  onDurationChange,
  onPromptChange,
  onStyleReferenceUrlChange,
  onSubmit,
  onExitToLanding,
}: SetupProps) {
  const canSubmit = assets.length > 0 && prompt.trim().length > 0;

  return (
    <div className="pbj-setup">
      <TopBar onBack={onExitToLanding} />

      <div className="pbj-setup__body">
        <section className="pbj-setup__section pbj-setup__section--media">
          <MediaPicker assets={assets} onChange={onAssetsChange} />
        </section>

        <section className="pbj-setup__section">
          <SectionLabel title="Length" />
          <DurationSlider value={targetDurationSec} onChange={onDurationChange} />
        </section>

        <section className="pbj-setup__section">
          <SectionLabel title="Describe the Edit" />
          <PromptBox value={prompt} onChange={onPromptChange} />
        </section>

        <section className="pbj-setup__section">
          <SectionLabel title="Style Reference" badge="Optional" />
          <StyleReferenceSection url={styleReferenceUrl} onUrlChange={onStyleReferenceUrlChange} />
        </section>
      </div>

      <div className="pbj-setup__footer">
        <Button fullWidth onClick={onSubmit} disabled={!canSubmit}>
          Generate Edit ✨
        </Button>
      </div>
    </div>
  );
}
