import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  durationSec: number;
  /** Raw stored dimensions (before rotation metadata is applied). */
  width: number;
  height: number;
  /** Rotation in degrees from side-data, if any (e.g. -90 for a portrait
   *  phone video stored as landscape with a rotate tag). */
  rotation: number;
  /** Dimensions as the video actually displays once rotation is applied —
   *  what scale filters and Twelve Labs' resolution floor actually care about. */
  displayWidth: number;
  displayHeight: number;
}

export async function probe(filePath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,duration:stream_side_data=rotation:format=duration",
    "-of",
    "json",
    filePath,
  ]);

  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0] ?? {};
  const width = Number(stream.width) || 0;
  const height = Number(stream.height) || 0;
  const rotation = Number(stream.side_data_list?.[0]?.rotation) || 0;
  const durationSec = Number(stream.duration) || Number(parsed.format?.duration) || 0;

  const rotated = Math.abs(rotation) === 90 || Math.abs(rotation) === 270;
  const displayWidth = rotated ? height : width;
  const displayHeight = rotated ? width : height;

  return { durationSec, width, height, rotation, displayWidth, displayHeight };
}

/**
 * Compresses a video down for Twelve Labs' ~22MB local-upload cap, the same
 * approach worked out by hand in style-test/README.md: orientation-aware
 * scaling (so the display short side never drops below Twelve Labs' 360px
 * floor — the flat "scale to N:-2" mistake that broke the very first raw
 * Rome/flight passes this session), fps capped, audio stripped since only
 * the visual shot-detection pass is needed server-side.
 *
 * Accepts an AbortSignal so a caller that's given up on this attempt (a
 * timeout, or a retry moving on) can actually kill the ffmpeg process
 * instead of leaving it to run to completion for no one — the stress test
 * found abandoned compress+analyze work continuing in the background after
 * the client had already been told the request failed.
 */
export async function compressForUnderstanding(
  inputPath: string,
  outputPath: string,
  info: ProbeResult,
  signal?: AbortSignal
): Promise<void> {
  const isPortrait = info.displayHeight >= info.displayWidth;
  const scaleFilter = isPortrait ? "scale=380:-2" : "scale=-2:380";

  const targetBytes = 20 * 1024 * 1024;
  const durationSec = Math.max(info.durationSec, 1);
  const targetKbps = Math.max(80, Math.min(2500, Math.floor((targetBytes * 8) / durationSec / 1000)));

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      inputPath,
      "-vf",
      `${scaleFilter},fps=15`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-b:v",
      `${targetKbps}k`,
      "-maxrate",
      `${Math.round(targetKbps * 1.3)}k`,
      "-bufsize",
      `${Math.round(targetKbps * 2)}k`,
      outputPath,
    ],
    { signal }
  );
}

/**
 * Rewrites a video's container so the `moov` atom (metadata: duration,
 * dimensions, seek index) sits at the front of the file instead of the
 * end — a pure stream copy, no re-encoding, so it's fast even on a
 * 200MB+ file. Phone recordings and screen recordings routinely write
 * `moov` last (it can only be finalized once recording stops), which
 * silently breaks browser <video> thumbnails: the element can't read
 * metadata without first locating `moov`, Chrome doesn't reliably chase
 * it down at the end of a large progressively-loaded file, and the
 * preview just hangs forever with no error and no thumbnail. Running
 * every upload through this once, right after it lands, means every
 * clip served back to the browser is playable-from-the-start.
 */
export async function remuxFaststart(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

export type FitMode = "pad" | "crop";

/** Trims one source file to [inSec, outSec) and normalizes it to a common
 *  frame size/rate/audio layout — necessary because clips uploaded from
 *  different people's phones can differ in codec/resolution, which the
 *  fast concat demuxer can't safely handle but a re-encoding
 *  filter_complex concat can.
 *
 *  `fit` controls how a source clip's native aspect ratio is reconciled
 *  with the target dimensions: "pad" letterboxes to fit inside the target
 *  box without cropping anything (used for the internal preview render,
 *  where the target box is just whichever uploaded clip happens to be
 *  largest — nothing should be cropped away just to make clips concat-
 *  compatible). "crop" fills the entire target box, cropping any overflow
 *  (used for an explicit export to a chosen aspect ratio — the standard
 *  "cover" behavior every social platform uses when you pick a format,
 *  and the only way changing the aspect ratio actually looks different). */
export async function trimAndNormalize(
  inputPath: string,
  outputPath: string,
  inSec: number,
  outSec: number,
  targetWidth: number,
  targetHeight: number,
  fit: FitMode = "pad",
  signal?: AbortSignal
): Promise<void> {
  const duration = Math.max(0.1, outSec - inSec);
  const vf =
    fit === "crop"
      ? `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},fps=30,setsar=1`
      : `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1`;

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-ss",
      inSec.toFixed(2),
      "-i",
      inputPath,
      "-t",
      duration.toFixed(2),
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-af",
      "aresample=async=1",
      outputPath,
    ],
    { signal }
  );
}

/** Concatenates already-normalized (same codec/resolution/fps) segments
 *  with the concat demuxer — safe here because trimAndNormalize already
 *  made every segment uniform. Hard cuts only, no transition filters, per
 *  every confirmed Troy Osterberg edit's observed style. */
export async function concatSegments(segmentPaths: string[], listFilePath: string, outputPath: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const listContent = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await fs.writeFile(listFilePath, listContent, "utf8");

  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFilePath,
    "-c",
    "copy",
    outputPath,
  ]);
}
