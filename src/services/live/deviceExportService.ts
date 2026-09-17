import type { EditPlan, ExportOptions } from "../../types";
import type { ExportService, ExportResult, RenderService } from "../interfaces";

/**
 * Real ExportService: there is no browser API that writes directly into a
 * device's Photos library — that capability simply doesn't exist on the
 * web platform. The closest real mechanism is the Web Share API with a
 * file attached, which on iOS/Android surfaces "Save Video"/"Save to
 * Photos" as one of the native share-sheet options; where that's
 * unavailable (most desktop browsers), this falls back to a plain
 * download. `savedToLibrary` reflects which path actually ran, not a
 * guarantee the person tapped "save" inside the share sheet.
 *
 * Always re-renders from the current plan rather than reusing whatever
 * the preview player last showed, so what's exported exactly matches the
 * latest manual edits even if "render" wasn't re-pressed since then.
 */
export class DeviceExportService implements ExportService {
  private renderService: RenderService;

  constructor(renderService: RenderService) {
    this.renderService = renderService;
  }

  async export(plan: EditPlan, options: ExportOptions): Promise<ExportResult> {
    const { videoUrl } = await this.renderService.render(plan, options);
    const response = await fetch(videoUrl);
    const blob = await response.blob();

    const fileName = `PBJ_${plan.id}_${options.resolution}_${options.aspectRatio.replace(":", "x")}.mp4`;
    const file = new File([blob], fileName, { type: "video/mp4" });

    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean;
      share?: (data: { files: File[]; title?: string }) => Promise<void>;
    };

    if (nav.canShare?.({ files: [file] }) && nav.share) {
      try {
        await nav.share({ files: [file], title: fileName });
        return { success: true, savedToLibrary: true, fileName };
      } catch (err) {
        // canShare() === true is not a guarantee share() will succeed —
        // it can still throw (permission denied, no active user-gesture
        // context, the user dismissing the share sheet). Found live: this
        // was throwing NotAllowedError and, uncaught, left the export
        // flow spinning forever with no feedback. Fall back to a plain
        // download instead of failing the whole export.
        if (err instanceof Error && err.name === "AbortError") {
          throw err; // the user deliberately cancelled the share sheet — respect that, don't silently download instead
        }
      }
    }

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);

    return { success: true, savedToLibrary: false, fileName };
  }
}
