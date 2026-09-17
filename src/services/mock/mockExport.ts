import type { EditPlan, ExportOptions } from "../../types";
import type { ExportService, ExportResult } from "../interfaces";
import { delay } from "../../utils/id";

/**
 * Stand-in for the render/export vendor (e.g. Shotstack render + a device
 * Photos-library save). Simulates render + save latency and always
 * succeeds for this mocked MVP pass.
 */
export class MockExportService implements ExportService {
  async export(plan: EditPlan, options: ExportOptions): Promise<ExportResult> {
    await delay(1800 + Math.random() * 900);

    const fileName = `PBJ_${plan.id}_${options.resolution}_${options.aspectRatio.replace(
      ":",
      "x"
    )}.mp4`;

    return {
      success: true,
      savedToLibrary: true,
      fileName,
    };
  }
}
