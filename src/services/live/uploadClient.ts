import type { MediaAsset } from "../../types";
import { apiBase, apiFetch } from "./apiBase";

interface UploadedAsset {
  id: string;
  kind: "video" | "photo";
  fileName: string;
  durationSec: number;
  sizeBytes: number;
  fileUrl: string;
}

/**
 * Uploads real files to the shared backend — used in place of the old
 * `URL.createObjectURL` local-blob approach so that (a) any device on the
 * LAN can contribute footage, not just the one that started the project,
 * and (b) every device's video preview works identically, since it's
 * loading from the shared server instead of a blob URL that only exists
 * inside one browser tab.
 */
export async function uploadFiles(files: File[]): Promise<MediaAsset[]> {
  const formData = new FormData();
  for (const file of files) formData.append("files", file);

  const res = await apiFetch("/api/assets", { method: "POST", body: formData });
  const body: { assets: UploadedAsset[] } = await res.json();

  return body.assets.map((a) => ({
    id: a.id,
    kind: a.kind,
    fileName: a.fileName,
    previewUrl: `${apiBase()}${a.fileUrl}`,
    durationSec: a.durationSec,
    sizeBytes: a.sizeBytes,
  }));
}
