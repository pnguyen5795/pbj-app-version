import { useCallback, useState } from "react";
import { TIER_CAPS, CURRENT_TIER } from "../data/placeholders";
import { readVideoDuration, captureVideoThumbnail } from "../utils/videoCapture";
import type { NewProjectDraft, UploadedClip } from "../state/useAppFlow";
import { NewProjectDetails } from "./NewProjectDetails";
import { NewProjectPrompt } from "./NewProjectPrompt";
import { DURATION_DEFAULT_SEC } from "../components/DurationRangeSlider";

type Clip = UploadedClip;
type Step = 1 | 2;

/**
 * New Project — now two screens (see NewProjectDetails / NewProjectPrompt),
 * not one. This wrapper owns every field of the draft-in-progress and just
 * switches which screen renders; nothing unmounts between them, so
 * everything already entered survives moving forward OR back.
 */
export function NewProject({
  initialDraft,
  initialStep,
  onBack,
  onSubmit,
}: {
  initialDraft: NewProjectDraft | null;
  initialStep?: Step;
  onBack: () => void;
  onSubmit: (draft: NewProjectDraft) => void;
}) {
  const tier = TIER_CAPS.find((t) => t.name === CURRENT_TIER)!;
  const footageCapSec = tier.footageHours * 60 * 60;

  const [step, setStep] = useState<Step>(initialStep ?? 1);
  const [title, setTitle] = useState(initialDraft?.title ?? "New Project");
  // Seeded from the draft (not always empty) so tapping "edit" from Cooking
  // returns to the exact clips — thumbnails included — the creator already
  // uploaded, instead of losing them.
  const [clips, setClips] = useState<Clip[]>(initialDraft?.clips ?? []);
  const [durationSec, setDurationSec] = useState(initialDraft?.durationSec ?? DURATION_DEFAULT_SEC);
  const [styleIds, setStyleIds] = useState<string[]>(initialDraft?.styleIds ?? []);
  const [prompt, setPrompt] = useState(initialDraft?.prompt ?? "");

  // Nulls (unresolved/unreadable clips) contribute 0 to the sum, which is
  // mathematically identical to skipping them — never counted as a real
  // 0s duration, just absent from the total.
  const totalFootageSec = clips.reduce((sum, c) => sum + (c.durationSec ?? 0), 0);
  const isOverLimit = clips.length > 0 && totalFootageSec > footageCapSec;

  // Stable across renders (empty deps — each only closes over setClips,
  // itself stable) so the memoized clip grid below can bail out of
  // re-rendering when only durationSec changes during a slider drag.
  const addFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const newClips = await Promise.all(
      files.map(async (file) => {
        const [durationSec, thumbnailUrl] = await Promise.all([
          readVideoDuration(file),
          captureVideoThumbnail(file),
        ]);
        return {
          id: `${file.name}-${file.size}-${file.lastModified}`,
          fileName: file.name,
          durationSec,
          thumbnailUrl,
        };
      })
    );
    setClips((prev) => [...prev, ...newClips]);
  }, []);

  const removeLastClip = useCallback(() => {
    setClips((prev) => prev.slice(0, -1));
  }, []);

  const removeClip = useCallback((id: string) => {
    setClips((prev) => prev.filter((c) => c.id !== id));
  }, []);

  function submit() {
    onSubmit({
      title,
      clipCount: clips.length,
      totalFootageSec,
      durationSec,
      // Derived from durationSec, never edited directly — kept only for
      // its existing consumers (App.tsx's EMPTY_DRAFT fallback shape, and
      // this screen's own reseed-on-edit read); nothing downstream
      // (Cooking, Studio) reads it.
      durationCapMin: Math.round(durationSec / 60) || 1,
      prompt,
      styleIds,
      clips,
    });
  }

  if (step === 1) {
    return (
      <NewProjectDetails
        title={title}
        onTitleChange={setTitle}
        clips={clips}
        onAddFiles={addFiles}
        totalFootageSec={totalFootageSec}
        isOverLimit={isOverLimit}
        footageCapSec={footageCapSec}
        onRemoveLastClip={removeLastClip}
        onRemoveClip={removeClip}
        durationSec={durationSec}
        onDurationChange={setDurationSec}
        onBack={onBack}
        onNext={() => setStep(2)}
      />
    );
  }

  return (
    <NewProjectPrompt
      styleIds={styleIds}
      onStyleIdsChange={setStyleIds}
      prompt={prompt}
      onPromptChange={setPrompt}
      onBack={() => setStep(1)}
      onSubmit={submit}
    />
  );
}
