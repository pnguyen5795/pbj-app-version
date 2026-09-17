// Single wiring point for the service layer.
//
// Every screen/component imports services from here, never from
// `./mock/*` directly. To integrate a real vendor later (Twelve Labs,
// Shotstack, a style-scraper, real device Photos APIs, ...):
//   1. Implement the relevant interface from `./interfaces` in a new file
//      (e.g. `services/live/twelveLabsUnderstanding.ts`).
//   2. Swap the constructor call below.
// No screen or component code needs to change.

import { MockStyleAnalysisService } from "./mock/mockStyleAnalysis";
import { PatternEditPlanService } from "./live/patternEditPlanService";
import { TwelveLabsUnderstandingService } from "./live/twelveLabsUnderstanding";
import { FfmpegRenderService } from "./live/ffmpegRenderService";
import { DeviceExportService } from "./live/deviceExportService";
import { MockChatEditService } from "./mock/mockChatEdit";
import { MockProcessingOrchestrator } from "./mock/mockOrchestrator";
import { MockStyleLibraryService } from "./mock/mockStyleLibrary";
import { LiveStyleTrainingService } from "./live/styleTrainingService";

// Real: calls the backend, which calls Twelve Labs (server/src/twelveLabs.ts).
export const videoUnderstandingService = new TwelveLabsUnderstandingService();
// Still mocked — no real "resolve a creator's published edits from a
// link/name" vendor is wired in. The prompt/style name still reaches
// PatternEditPlanService below, which is what actually matches it against
// a confirmed profile (see src/data/styleProfiles).
export const styleAnalysisService = new MockStyleAnalysisService();
// Real planner: applies a named creator's confirmed style profile to
// produce an actual reasoned Play + shot list, not a plausible-looking fake.
export const editPlanService = new PatternEditPlanService();
// Real: sends the shot list to the backend, which runs actual ffmpeg
// trim + concat and returns a real playable output file.
export const renderService = new FfmpegRenderService();
export const chatEditService = new MockChatEditService();
// Real: re-renders the current plan and hands it off via the Web Share
// API (mobile "Save to Photos") or a plain download (desktop fallback) —
// see deviceExportService.ts for why there's no stronger option.
export const exportService = new DeviceExportService(renderService);
export const styleLibraryService = new MockStyleLibraryService();
// Real: submits raw/final pairs (or finished-only reference clips) to the
// backend's separate training-project store — see server/src/trainingStore.ts.
export const styleTrainingService = new LiveStyleTrainingService();

export const processingOrchestrator = new MockProcessingOrchestrator(
  videoUnderstandingService,
  styleAnalysisService,
  editPlanService,
  renderService
);

export * from "./interfaces";
