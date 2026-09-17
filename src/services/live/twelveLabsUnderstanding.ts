import type { MediaAsset } from "../../types";
import type { VideoUnderstandingService, VideoUnderstandingResult } from "../interfaces";
import { apiFetch } from "./apiBase";

/**
 * Real VideoUnderstandingService: asks the backend to run each uploaded
 * video through Twelve Labs' pegasus1.5 shot-detection pass (the backend
 * handles compression-for-upload-limits and holds the API key — neither
 * of those can happen in the browser). Assets must already have gone
 * through uploadFiles() so the backend recognizes their ids.
 */
export class TwelveLabsUnderstandingService implements VideoUnderstandingService {
  async analyze(assets: MediaAsset[]): Promise<VideoUnderstandingResult> {
    const assetIds = assets.map((a) => a.id);
    const res = await apiFetch("/api/understand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetIds }),
    });
    return (await res.json()) as VideoUnderstandingResult;
  }
}
