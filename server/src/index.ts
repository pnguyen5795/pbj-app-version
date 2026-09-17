import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { listProjectsForUser, saveProject } from "./projectsStore.js";

import { UPLOADS_DIR, RENDERS_DIR, TMP_DIR, TRAINING_FILES_DIR, ANALYSIS_MANIFEST_PATH } from "./paths.js";
import { probe, compressForUnderstanding, trimAndNormalize, concatSegments, remuxFaststart, type FitMode } from "./ffmpeg.js";
import { analyzeShots, type ShotsResult } from "./twelveLabs.js";
import { mapWithConcurrency, delay, TWELVE_LABS_JOB_CONCURRENCY } from "./concurrency.js";
import { hashFile, getCachedAnalysis, setCachedAnalysis } from "./analysisCache.js";
import {
  listTrainingProjects,
  getTrainingProject,
  saveTrainingProject,
  getLearnedAdjustments,
  applyApprovedProposals,
  type TrainingProject,
  type TrainingProjectType,
} from "./trainingStore.js";
import { analyzeFinishedOnly, analyzeRawPlusFinal } from "./styleTrainingAnalysis.js";
import { enqueueAnalysisJob } from "./trainingQueue.js";

const PORT = Number(process.env.PORT) || 4000;
const API_KEY = process.env.TWELVE_LABS_API_KEY;

interface AssetRecord {
  id: string;
  fileName: string;
  storedPath: string;
  sizeBytes: number;
  durationSec: number;
  displayWidth: number;
  displayHeight: number;
  kind: "video" | "photo";
}

// In-memory registry mapping asset/render ids to disk paths — this is a
// local single-machine testing tool (not a multi-instance production
// service), so a process-lifetime Map is the right amount of durability:
// simple, and uploaded files themselves persist on disk across restarts
// even though their id lookup doesn't.
const assets = new Map<string, AssetRecord>();

const app = express();
// exposedHeaders matters specifically for the <video> tags in MediaPicker/
// VideoPlayer: the frontend (port 5173) and this API (port 4000) are
// different origins, so a video element's Range request is cross-origin.
// Without Content-Range/Accept-Ranges explicitly exposed, the browser's
// media engine can't read the byte-range confirmation it needs to trust a
// 206 response and just stalls forever at readyState 0 — no thumbnail, no
// error, nothing — even though the response itself (verified with curl) is
// perfectly valid.
app.use(cors({ exposedHeaders: ["Content-Range", "Accept-Ranges", "Content-Length"] }));
app.use(express.json({ limit: "10mb" }));
// Reads CLERK_SECRET_KEY from env automatically (dotenv/config above has
// already loaded server/.env). Non-blocking: it attaches req.auth to every
// request but doesn't reject unauthenticated ones — none of the existing
// upload/render/etc. routes are gated behind auth in this pass, only the
// new /api/auth/whoami below (added specifically to prove the backend can
// verify a real Clerk session, not just that the SDK is installed).
app.use(clerkMiddleware());

const upload = multer({ storage: multer.diskStorage({ destination: UPLOADS_DIR, filename: (_req, file, cb) => {
  cb(null, `${randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
}}) });

function log(message: string) {
  console.log(`[server] ${message}`);
}

// Belt-and-suspenders: a bug in one request handler (e.g. a stream error
// callback that fires after headers are already sent) should never be able
// to crash the whole process and take every other in-flight/future request
// down with it — this is a single-process local dev tool, so "log it and
// keep serving" is strictly better than "die and require a manual restart".
process.on("uncaughtException", (err) => {
  log(`uncaught exception (server stays up): ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection (server stays up): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

/** `execFile`'s promisified rejection message is "Command failed: ffmpeg
 *  -y -i /full/path ...\n<stderr>" — accurate but unreadable for an end
 *  user. Keep just the last non-empty stderr line (invariably the actual
 *  reason, e.g. "Invalid data found when processing input"), and strip
 *  the server's own internal storage path down to a bare filename. */
function cleanExecError(message: string): string {
  const withoutInternalPaths = message.replaceAll(`${UPLOADS_DIR}/`, "").replaceAll(`${TMP_DIR}/`, "");
  if (!withoutInternalPaths.startsWith("Command failed:")) return withoutInternalPaths;
  const lines = withoutInternalPaths.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? withoutInternalPaths;
}

// --- Upload -----------------------------------------------------------
// Any device on the LAN posts its own files here directly; nothing about
// this endpoint assumes the uploader is the same machine running the
// server or the dev frontend.
app.post("/api/assets", upload.array("files"), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: "No files uploaded" });
    return;
  }

  try {
    const records = await Promise.all(
      files.map(async (file): Promise<AssetRecord> => {
        // The client-supplied MIME type isn't reliable across every
        // upload path (e.g. curl guesses application/octet-stream for
        // some containers) — ask ffprobe whether there's actually a
        // video stream instead of trusting it.
        let durationSec = 3;
        let displayWidth = 0;
        let displayHeight = 0;
        let isVideo = file.mimetype.startsWith("video/");

        try {
          const info = await probe(file.path);
          if (info.durationSec > 0) {
            isVideo = true;
            durationSec = info.durationSec;
            displayWidth = info.displayWidth;
            displayHeight = info.displayHeight;
          }
        } catch {
          // Not a video ffprobe can read — leave isVideo as whatever the
          // MIME type suggested (likely a photo).
        }

        let sizeBytes = file.size;
        if (isVideo) {
          // Phone/screen recordings routinely write `moov` at the end of
          // the file — harmless for ffmpeg, but it silently breaks the
          // browser <video> thumbnail preview (see remuxFaststart). Do
          // this once, right after upload, so every asset served back to
          // the client is already thumbnail-safe.
          const faststartPath = path.join(TMP_DIR, `${randomUUID()}-faststart.mp4`);
          try {
            await remuxFaststart(file.path, faststartPath);
            await fs.rename(faststartPath, file.path);
            sizeBytes = (await fs.stat(file.path)).size;
          } catch (err) {
            await fs.rm(faststartPath, { force: true }).catch(() => {});
            log(`faststart remux failed for ${file.originalname} (thumbnail preview may not load): ${cleanExecError((err as Error).message)}`);
          }
        }

        const record: AssetRecord = {
          id: randomUUID(),
          fileName: file.originalname,
          storedPath: file.path,
          sizeBytes,
          durationSec,
          displayWidth,
          displayHeight,
          kind: isVideo ? "video" : "photo",
        };
        assets.set(record.id, record);
        return record;
      })
    );

    log(`uploaded ${records.length} file(s): ${records.map((r) => r.fileName).join(", ")}`);

    res.json({
      assets: records.map((r) => ({
        id: r.id,
        kind: r.kind,
        fileName: r.fileName,
        durationSec: r.durationSec,
        sizeBytes: r.sizeBytes,
        fileUrl: `/api/assets/${r.id}/file`,
      })),
    });
  } catch (err) {
    log(`upload failed: ${(err as Error).message}`);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/assets/:id/file", (req, res) => {
  const record = assets.get(req.params.id);
  if (!record) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }
  res.sendFile(path.resolve(record.storedPath));
});

// --- Understanding (real Twelve Labs) ----------------------------------
// Each asset is compressed + analyzed independently, with its own retry
// and its own timeout/cancellation — so one flaky clip can never discard
// another clip's already-completed (and already-paid-for) analysis, and a
// timed-out attempt actually stops running instead of continuing in the
// background after we've moved on from it. Concurrency is bounded rather
// than firing every asset at once, since the stress test traced repeated
// failures to CPU contention between many simultaneous local ffmpeg jobs.
const UNDERSTAND_CONCURRENCY = TWELVE_LABS_JOB_CONCURRENCY;
const UNDERSTAND_MAX_ATTEMPTS = 2;

function timeoutForDuration(durationSec: number): number {
  // Observed: a 14:51 clip took ~15.5 minutes for one real attempt. Scale
  // generously with source duration so a legitimately slow-but-succeeding
  // call on long footage isn't mistaken for a hang, but cap it so a truly
  // stuck request doesn't wait forever.
  return Math.min(20 * 60 * 1000, Math.max(90_000, durationSec * 1200));
}

interface AssetAnalysis {
  assetId: string;
  summary: string;
  tags: string[];
  scenes?: { startSec: number; endSec: number; description: string; objects: string[]; actions: string[] }[];
}

/** Shared by the cache-hit and cache-miss paths so both produce identical
 *  output from a raw Twelve Labs shots response — a cache hit must look
 *  exactly like a fresh call would have, not a separate, possibly-drifted
 *  code path. */
function buildAssetAnalysis(record: AssetRecord, shots: ShotsResult): AssetAnalysis {
  const scenes = (shots.scenes ?? []).map((s) => ({
    startSec: s.start_sec,
    endSec: s.end_sec,
    description: s.description,
    objects: s.objects ?? [],
    actions: s.actions ?? [],
  }));

  const objectTally = new Map<string, number>();
  for (const scene of scenes) {
    for (const obj of scene.objects) objectTally.set(obj, (objectTally.get(obj) ?? 0) + 1);
  }
  const topTags = [...objectTally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);

  const summary =
    scenes.length > 0
      ? `${scenes.length} shot${scenes.length === 1 ? "" : "s"} detected. ${scenes[0].description}`
      : `No distinct shots detected in ${record.fileName}.`;

  return { assetId: record.id, summary, tags: topTags, scenes };
}

async function analyzeOneAsset(record: AssetRecord): Promise<AssetAnalysis> {
  if (record.kind !== "video") {
    return { assetId: record.id, summary: `A photo (${record.fileName}).`, tags: ["photo"] };
  }

  // Content-based cache gate: hash the actual uploaded bytes (never the
  // filename/path) so the same video re-uploaded under a different name,
  // from a different device, or re-sent by the per-upload retry logic
  // above never triggers a second paid Twelve Labs call. Checked before
  // any compression happens, so a cache hit skips that work too.
  const hash = await hashFile(record.storedPath);
  const cached = await getCachedAnalysis(hash);
  if (cached) {
    log(`[cache hit] skipping Twelve Labs analysis for ${record.fileName} (sha256 ${hash.slice(0, 12)}…, originally analyzed ${cached.analyzedAt} as "${cached.originalFilename}")`);
    return buildAssetAnalysis(record, cached.analysisResult);
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= UNDERSTAND_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutMs = timeoutForDuration(record.durationSec);
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    const compressedPath = path.join(TMP_DIR, `${record.id}-attempt${attempt}-compressed.mp4`);

    try {
      log(`compressing ${record.fileName} for Twelve Labs (attempt ${attempt}/${UNDERSTAND_MAX_ATTEMPTS})...`);
      const info = await probe(record.storedPath);
      await compressForUnderstanding(record.storedPath, compressedPath, info, controller.signal);

      log(`analyzing ${record.fileName} with Twelve Labs (pegasus1.5)...`);
      const shots = await analyzeShots(compressedPath, API_KEY!, controller.signal);
      clearTimeout(timer);
      await fs.unlink(compressedPath).catch(() => {});

      await setCachedAnalysis(hash, {
        analyzedAt: new Date().toISOString(),
        originalFilename: record.fileName,
        durationSeconds: record.durationSec,
        analysisResult: shots,
      });
      log(`[cache miss] stored new Twelve Labs analysis for ${record.fileName} (sha256 ${hash.slice(0, 12)}…)`);

      const analysis = buildAssetAnalysis(record, shots);
      log(`${record.fileName}: ${analysis.scenes?.length ?? 0} shots detected`);
      return analysis;
    } catch (err) {
      clearTimeout(timer);
      // The signal is now aborted either because we just timed out (which
      // kills the in-flight ffmpeg process and/or fetch immediately — no
      // orphaned work left running) or because the try block already
      // finished; either way abort() again is a harmless no-op.
      controller.abort();
      await fs.unlink(compressedPath).catch(() => {});

      const rawMessage = err instanceof Error ? err.message : String(err);
      lastError = new Error(cleanExecError(rawMessage));
      log(`${record.fileName}: attempt ${attempt}/${UNDERSTAND_MAX_ATTEMPTS} failed — ${lastError.message}`);
      if (attempt < UNDERSTAND_MAX_ATTEMPTS) await delay(1000 * attempt);
    }
  }

  throw new Error(`${record.fileName}: ${lastError?.message ?? "unknown error"} (after ${UNDERSTAND_MAX_ATTEMPTS} attempts)`);
}

app.post("/api/understand", async (req, res) => {
  if (!API_KEY) {
    res.status(500).json({ error: "TWELVE_LABS_API_KEY is not set on the server (server/.env)." });
    return;
  }

  const assetIds: string[] = req.body?.assetIds ?? [];
  const records = assetIds.map((id) => assets.get(id)).filter((r): r is AssetRecord => !!r);
  if (records.length === 0) {
    res.status(400).json({ error: "No known assetIds provided." });
    return;
  }

  const outcomes = await mapWithConcurrency(records, UNDERSTAND_CONCURRENCY, async (record) => {
    try {
      return { record, ok: true as const, analysis: await analyzeOneAsset(record) };
    } catch (err) {
      return { record, ok: false as const, message: err instanceof Error ? err.message : String(err) };
    }
  });

  const succeeded = outcomes.filter((o): o is { record: AssetRecord; ok: true; analysis: AssetAnalysis } => o.ok);
  const failed = outcomes.filter((o): o is { record: AssetRecord; ok: false; message: string } => !o.ok);

  if (succeeded.length === 0) {
    res.status(502).json({
      error: "Twelve Labs analysis failed for every clip.",
      failures: failed.map((f) => ({ assetId: f.record.id, fileName: f.record.fileName, message: f.message })),
    });
    return;
  }

  const videoCount = succeeded.filter((o) => o.record.kind === "video").length;
  res.json({
    assetSummaries: succeeded.map((o) => o.analysis),
    overallSummary: `Analyzed ${succeeded.length} item(s) with Twelve Labs (${videoCount} video${videoCount === 1 ? "" : "s"}).`,
    // Surfaced by the client so the UI can show specifically which clips
    // were skipped and why, instead of the whole request failing silently
    // or a generic error swallowing every other clip's real results.
    warnings:
      failed.length > 0
        ? failed.map((f) => `${f.record.fileName} couldn't be analyzed and was skipped: ${f.message}`)
        : undefined,
  });
});

// --- Render (real ffmpeg) ----------------------------------------------
interface RenderClip {
  sourceAssetId: string;
  sourceInSec: number;
  sourceOutSec: number;
}

interface ExportOptionsBody {
  resolution: "720p" | "1080p" | "4K";
  aspectRatio: "9:16" | "1:1" | "4:5" | "16:9";
}

// Real-world dimensions matching how social platforms actually export each
// aspect ratio at each quality tier (e.g. Instagram's 4:5 is 1080x1350 at
// "1080p", not a naive 4:5 division of 1080). Explicit lookup beats a
// formula here since these are fixed, well-known targets.
const EXPORT_DIMENSIONS: Record<ExportOptionsBody["aspectRatio"], Record<ExportOptionsBody["resolution"], { width: number; height: number }>> = {
  "9:16": { "720p": { width: 720, height: 1280 }, "1080p": { width: 1080, height: 1920 }, "4K": { width: 2160, height: 3840 } },
  "16:9": { "720p": { width: 1280, height: 720 }, "1080p": { width: 1920, height: 1080 }, "4K": { width: 3840, height: 2160 } },
  "1:1": { "720p": { width: 720, height: 720 }, "1080p": { width: 1080, height: 1080 }, "4K": { width: 2160, height: 2160 } },
  "4:5": { "720p": { width: 864, height: 1080 }, "1080p": { width: 1080, height: 1350 }, "4K": { width: 2160, height: 2700 } },
};

const RENDER_CONCURRENCY = 4;

app.post("/api/render", async (req, res) => {
  const clips: RenderClip[] = req.body?.clips ?? [];
  const exportOptions: ExportOptionsBody | undefined = req.body?.exportOptions;
  if (clips.length === 0) {
    res.status(400).json({ error: "No clips in plan." });
    return;
  }

  const records = clips.map((c) => assets.get(c.sourceAssetId));
  const missing = clips.filter((_, i) => !records[i]);
  if (missing.length > 0) {
    res.status(400).json({ error: `Unknown sourceAssetId(s): ${missing.map((c) => c.sourceAssetId).join(", ")}` });
    return;
  }

  const renderId = randomUUID();
  const jobDir = path.join(TMP_DIR, renderId);
  await fs.mkdir(jobDir, { recursive: true });

  try {
    let targetWidth: number;
    let targetHeight: number;
    let fit: FitMode;

    if (exportOptions) {
      // An explicit export: crop-to-fill the chosen aspect ratio/resolution
      // — this is what actually makes picking a different option in the
      // Export sheet change the output, not just the filename.
      ({ width: targetWidth, height: targetHeight } = EXPORT_DIMENSIONS[exportOptions.aspectRatio][exportOptions.resolution]);
      fit = "crop";
      log(`exporting ${clips.length} clip(s) at ${targetWidth}x${targetHeight} (${exportOptions.aspectRatio} ${exportOptions.resolution})...`);
    } else {
      // The internal preview render: just make every clip's frame size
      // consistent enough to concatenate, without cropping anyone's
      // footage away — pad to the largest uploaded clip's native size.
      const dims = await Promise.all(records.map((r) => probe(r!.storedPath)));
      targetWidth = Math.max(...dims.map((d) => d.displayWidth), 720);
      targetHeight = Math.max(...dims.map((d) => d.displayHeight), 1280);
      fit = "pad";
      log(`rendering ${clips.length} clip(s) at ${targetWidth}x${targetHeight}...`);
    }

    // Trim+normalize every clip in parallel (bounded, since these are real
    // CPU-bound ffmpeg processes) instead of one at a time — the stress
    // test found a 12-clip render from one large source file taking 4.7
    // minutes sequentially; this is the fix for render time scaling
    // linearly with clip count.
    const segmentPaths = await mapWithConcurrency(clips, RENDER_CONCURRENCY, async (clip, i) => {
      const record = records[i]!;
      const segmentPath = path.join(jobDir, `seg_${i}.mp4`);
      await trimAndNormalize(record.storedPath, segmentPath, clip.sourceInSec, clip.sourceOutSec, targetWidth, targetHeight, fit);
      return segmentPath;
    });

    const outputFileName = `${renderId}.mp4`;
    const outputPath = path.join(RENDERS_DIR, outputFileName);
    await concatSegments(segmentPaths, path.join(jobDir, "concat.txt"), outputPath);

    await fs.rm(jobDir, { recursive: true, force: true });

    log(`render complete: ${outputFileName}`);
    const videoUrl = `/api/renders/${renderId}/file`;

    // Only the initial preview render (no exportOptions) represents "a new
    // project was made" — re-exporting an already-finished edit at a
    // different resolution/aspect ratio (ExportSheet) re-hits this same
    // route with exportOptions set and shouldn't create a second Dashboard
    // entry for the same edit.
    if (!exportOptions) {
      const { userId } = getAuth(req);
      if (userId) {
        const durationSec = clips.reduce((sum, c) => sum + Math.max(0, c.sourceOutSec - c.sourceInSec), 0);
        const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : "Untitled edit";
        await saveProject({ id: renderId, userId, name, createdAt: new Date().toISOString(), durationSec, videoUrl });
      } else {
        // Shouldn't normally happen — every request reaching this route
        // came from the Clerk-gated frontend, which always has a session
        // to attach — but don't let a missing/expired token break the
        // render itself, just skip persisting it to anyone's dashboard.
        log(`render ${renderId} completed with no authenticated user — not saved to any Dashboard`);
      }
    }

    res.json({ videoUrl });
  } catch (err) {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    log(`render failed: ${(err as Error).message}`);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/renders/:id/file", (req, res) => {
  const filePath = path.join(RENDERS_DIR, `${req.params.id}.mp4`);
  res.sendFile(path.resolve(filePath), (err) => {
    // sendFile's error callback also fires for errors *after* it has
    // already started streaming the response (e.g. the client aborts a
    // mid-download, like a <video> unmounting) — calling res.status/json
    // in that case throws ERR_HTTP_HEADERS_SENT, and because this is an
    // async callback (not the route handler itself), Express can't catch
    // that throw. It becomes an uncaught exception and kills the whole
    // process, taking down every other in-flight and future request —
    // this is what actually caused "upload stopped working" earlier.
    if (err && !res.headersSent) res.status(404).json({ error: "Render not found" });
  });
});

// --- Style training (separate from the regular upload/render flow) ---
// A persistent, separate corpus of creator-submitted raw/final pairs (or
// finished-only reference clips) used to grow the confirmed style
// profile over time — never touches `assets`/UPLOADS_DIR or the
// render/export pipeline above.
const trainingUpload = multer({
  storage: multer.diskStorage({
    destination: TRAINING_FILES_DIR,
    filename: (_req, file, cb) => {
      cb(null, `${randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
    },
  }),
});

function toClientProject(p: TrainingProject) {
  return {
    id: p.id,
    type: p.type,
    createdAt: p.createdAt,
    status: p.status,
    errorMessage: p.errorMessage,
    finalFileName: p.files.final.fileName,
    rawFileName: p.files.raw?.fileName,
    proposedDiff: p.proposedDiff,
    reviewStatus: p.reviewStatus,
    summary: p.summary,
  };
}

/** Only one confirmed style profile exists today (src/data/styleProfiles) —
 *  training submissions all target it until a second creator profile exists. */
const DEFAULT_TARGET_PROFILE_ID = "troy-osterberg";

async function shotsForTrainingFile(filePath: string, durationSec: number): Promise<ShotsResult["scenes"]> {
  // Reuses the exact same content-hash cache as the regular /api/understand
  // flow — a training video that happens to match something already
  // analyzed (or that gets submitted again later) never triggers a second
  // paid Twelve Labs call.
  const hash = await hashFile(filePath);
  const cached = await getCachedAnalysis(hash);
  if (cached) {
    log(`[cache hit] skipping Twelve Labs analysis for training file ${path.basename(filePath)} (sha256 ${hash.slice(0, 12)}…, originally analyzed ${cached.analyzedAt})`);
    return cached.analysisResult.scenes;
  }

  const info = await probe(filePath);
  const compressedPath = path.join(TMP_DIR, `training-${randomUUID()}-compressed.mp4`);
  try {
    await compressForUnderstanding(filePath, compressedPath, info);
    const shots = await analyzeShots(compressedPath, API_KEY!);
    await setCachedAnalysis(hash, {
      analyzedAt: new Date().toISOString(),
      originalFilename: path.basename(filePath),
      durationSeconds: durationSec,
      analysisResult: shots,
    });
    log(`[cache miss] stored new Twelve Labs analysis for training file ${path.basename(filePath)} (sha256 ${hash.slice(0, 12)}…)`);
    return shots.scenes;
  } finally {
    await fs.unlink(compressedPath).catch(() => {});
  }
}

/** The actual analysis work for one training project — runs inside the
 *  bounded background queue (trainingQueue.ts), never inline in the
 *  request handler, so a slow Twelve Labs call can never hold up the HTTP
 *  response for the upload that triggered it (or any other upload). Since
 *  this runs after the client has already been told "queued", errors here
 *  can't be returned as an HTTP response — they're persisted onto the
 *  project record instead, for the client to discover via polling. */
async function runTrainingAnalysis(project: TrainingProject): Promise<void> {
  const { type, files } = project;
  const finalInfo = files.final;
  const rawInfo = files.raw;

  await saveTrainingProject({ ...project, status: "analyzing" });
  log(`training submission ${project.id} analyzing (${type}): ${finalInfo.fileName}${rawInfo ? ` + raw ${rawInfo.fileName}` : ""}`);

  try {
    if (!API_KEY) throw new Error("TWELVE_LABS_API_KEY is not set on the server (server/.env).");

    const finalScenes = await shotsForTrainingFile(finalInfo.storedPath, finalInfo.durationSec);

    let diff;
    let summary: string;
    if (type === "finished-only") {
      diff = analyzeFinishedOnly(finalScenes, finalInfo.fileName);
      summary = `Recorded pacing/tone reference notes from ${finalInfo.fileName}. No raw footage means this can't affect keep/cut or hold-longest rules — approve the note below to add it as reference context only.`;
    } else {
      const rawScenes = await shotsForTrainingFile(rawInfo!.storedPath, rawInfo!.durationSec);
      diff = analyzeRawPlusFinal(rawScenes, finalScenes, rawInfo!.fileName, finalInfo.fileName);
      const parts: string[] = [];
      if (diff.cutCategoryProposals.length > 0) {
        parts.push(`${diff.cutCategoryProposals.length} new cut-category candidate${diff.cutCategoryProposals.length === 1 ? "" : "s"}`);
      }
      if (diff.holdSignalProposals.length > 0) {
        parts.push(`${diff.holdSignalProposals.length} hold-signal candidate${diff.holdSignalProposals.length === 1 ? "" : "s"}`);
      }
      summary =
        parts.length > 0
          ? `Compared ${rawInfo!.fileName} to ${finalInfo.fileName} and found ${parts.join(" and ")} awaiting your review` +
            `${diff.conflicts.length > 0 ? ` (${diff.conflicts.length} flagged as conflicting with the existing profile)` : ""}.`
          : `Compared ${rawInfo!.fileName} to ${finalInfo.fileName} — nothing rose to the level of a new confirmed pattern yet (not enough repeated evidence). Pacing notes were still recorded for review.`;
    }

    await saveTrainingProject({ ...project, status: "analyzed", proposedDiff: diff, reviewStatus: "pending", summary });
    log(`training submission ${project.id} analyzed`);
  } catch (err) {
    const message = cleanExecError(err instanceof Error ? err.message : String(err));
    await saveTrainingProject({ ...project, status: "failed", errorMessage: message, reviewStatus: "none" });
    log(`training submission ${project.id} failed: ${message}`);
  }
}

app.post(
  "/api/training/projects",
  trainingUpload.fields([
    { name: "final", maxCount: 1 },
    { name: "raw", maxCount: 1 },
  ]),
  async (req, res) => {
    const rawType = req.body?.type;
    if (rawType !== "finished-only" && rawType !== "raw-plus-final") {
      res.status(400).json({ error: `Invalid or missing submission type: ${String(rawType)}` });
      return;
    }
    const type: TrainingProjectType = rawType;

    const files = req.files as { final?: Express.Multer.File[]; raw?: Express.Multer.File[] } | undefined;
    const finalFile = files?.final?.[0];
    const rawFile = files?.raw?.[0];

    if (!finalFile) {
      res.status(400).json({ error: "A finished/edited video is required." });
      return;
    }
    if (type === "raw-plus-final" && !rawFile) {
      res.status(400).json({ error: "Raw footage is required for a raw-plus-final submission." });
      return;
    }

    async function fileInfo(f: Express.Multer.File) {
      let durationSec = 0;
      try {
        durationSec = (await probe(f.path)).durationSec;
      } catch {
        // Not a video ffprobe can read — leave durationSec at 0 rather
        // than failing the whole submission over it.
      }
      return { fileName: f.originalname, storedPath: f.path, sizeBytes: f.size, durationSec };
    }

    let project: TrainingProject;
    try {
      const finalInfo = await fileInfo(finalFile);
      const rawInfo = rawFile ? await fileInfo(rawFile) : undefined;

      project = {
        id: randomUUID(),
        type,
        targetProfileId: DEFAULT_TARGET_PROFILE_ID,
        createdAt: new Date().toISOString(),
        status: "queued",
        files: { final: finalInfo, raw: rawInfo },
        reviewStatus: "none",
      };
      await saveTrainingProject(project);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    log(`training submission ${project.id} queued (${type}): ${project.files.final.fileName}${project.files.raw ? ` + raw ${project.files.raw.fileName}` : ""}`);

    // Respond as soon as the file is safely on disk and the project
    // record exists — the client's next upload (or the next item in its
    // own concurrency-limited batch) can start immediately instead of
    // waiting for this one's Twelve Labs analysis, which runs in the
    // background via the bounded queue below and reports its own outcome
    // by updating the persisted project record for the client to poll.
    res.json({ project: toClientProject(project) });

    enqueueAnalysisJob(() => runTrainingAnalysis(project));
  }
);

app.get("/api/training/projects", async (_req, res) => {
  const projects = await listTrainingProjects();
  res.json({ projects: projects.map(toClientProject) });
});

app.get("/api/training/projects/:id", async (req, res) => {
  const project = await getTrainingProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Training project not found" });
    return;
  }
  res.json({ project: toClientProject(project) });
});

interface ReviewBody {
  decision: "approve" | "reject";
  cutCategoryIds?: string[];
  holdSignalIds?: string[];
  includeNotes?: boolean;
}

app.post("/api/training/projects/:id/review", async (req, res) => {
  const project = await getTrainingProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Training project not found" });
    return;
  }
  if (project.status !== "analyzed" || !project.proposedDiff) {
    res.status(400).json({ error: "This project has no pending proposals to review." });
    return;
  }

  const body = (req.body ?? {}) as ReviewBody;
  const reviewedAt = new Date().toISOString();

  if (body.decision === "approve") {
    await applyApprovedProposals(project, {
      cutCategoryIds: body.cutCategoryIds ?? [],
      holdSignalIds: body.holdSignalIds ?? [],
      includeNotes: body.includeNotes ?? false,
    });
    const updated: TrainingProject = { ...project, reviewStatus: "approved", reviewedAt };
    await saveTrainingProject(updated);
    log(`training submission ${project.id} approved`);
    res.json({ project: toClientProject(updated) });
    return;
  }

  if (body.decision === "reject") {
    const updated: TrainingProject = { ...project, reviewStatus: "rejected", reviewedAt };
    await saveTrainingProject(updated);
    log(`training submission ${project.id} rejected`);
    res.json({ project: toClientProject(updated) });
    return;
  }

  res.status(400).json({ error: `Invalid decision: ${String(body.decision)}` });
});

app.get("/api/training/learned-adjustments", async (_req, res) => {
  const adjustments = await getLearnedAdjustments();
  res.json({ adjustments });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasApiKey: !!API_KEY });
});

// Proves the backend can actually verify a real Clerk session token, not
// just that the SDK is installed. clerkMiddleware() (registered above)
// decodes any session token present but never blocks the request itself —
// the explicit 401 here is what actually enforces auth for this route.
// (Not using @clerk/express's requireAuth(): it's deprecated in this SDK
// version and defaults to a 302 redirect-to-sign-in rather than a JSON
// 401, which is wrong for an API endpoint like this one.)
app.get("/api/auth/whoami", (req, res) => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  res.json({ userId });
});

// Backs the Dashboard's recent-activity list — real saved projects for the
// signed-in user only, never mockProjects.ts.
app.get("/api/projects", async (req, res) => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const projects = await listProjectsForUser(userId);
  res.json({ projects });
});

function lanAddress(): string | null {
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

app.listen(PORT, "0.0.0.0", () => {
  const lan = lanAddress();
  log(`listening on http://localhost:${PORT}`);
  if (lan) log(`reachable on your LAN at http://${lan}:${PORT}`);
  log(`Twelve Labs analysis cache: ${ANALYSIS_MANIFEST_PATH}`);
  if (!API_KEY) log("WARNING: TWELVE_LABS_API_KEY is not set — /api/understand will fail until server/.env is filled in.");
});
