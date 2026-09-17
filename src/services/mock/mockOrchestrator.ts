import type { MediaAsset } from "../../types";
import type {
  ProcessingOrchestrator,
  ProcessingStep,
  VideoUnderstandingService,
  StyleAnalysisService,
  EditPlanService,
  RenderService,
  StyleReferenceInput,
} from "../interfaces";
import { delay } from "../../utils/id";

/**
 * Coordinates the full pipeline described in the spec: upload -> video
 * understanding -> style analysis -> edit plan -> render. This is the
 * single place that knows the pipeline order, so any individual step can
 * be swapped between mock and real without screens changing — as of this
 * pass, understanding/plan/render are all real; only style analysis
 * remains mocked (see services/index.ts).
 */
export class MockProcessingOrchestrator implements ProcessingOrchestrator {
  private understanding: VideoUnderstandingService;
  private style: StyleAnalysisService;
  private plan: EditPlanService;
  private render: RenderService;

  constructor(
    understanding: VideoUnderstandingService,
    style: StyleAnalysisService,
    plan: EditPlanService,
    render: RenderService
  ) {
    this.understanding = understanding;
    this.style = style;
    this.plan = plan;
    this.render = render;
  }

  async run(
    assets: MediaAsset[],
    targetDurationSec: number,
    prompt: string,
    styleReference: StyleReferenceInput | undefined,
    onStep: (step: ProcessingStep) => void
  ) {
    onStep("uploading");
    await delay(300); // assets are already uploaded by the time this runs (see MediaPicker) — brief pause just for screen-reading rhythm

    onStep("understanding");
    const understanding = await this.understanding.analyze(assets);

    onStep("style");
    const style = await this.style.analyze(prompt, styleReference);

    onStep("planning");
    const plan = await this.plan.generate({
      assets,
      targetDurationSec,
      prompt,
      understanding,
      style,
    });

    onStep("rendering");
    const { videoUrl } = await this.render.render(plan);

    onStep("done");

    // Surface both "some clips couldn't be analyzed" (from understanding)
    // and "not enough footage to hit the target" (from planning) — neither
    // is fatal to producing a result, but both need to be visible rather
    // than silently swallowed.
    const warnings = [...(understanding.warnings ?? []), ...(plan.warnings ?? [])];

    return {
      videoUrl,
      posterUrl: "",
      plan,
      warnings,
    };
  }
}
