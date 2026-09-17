import fs from "node:fs/promises";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { ANALYSIS_MANIFEST_PATH, CACHE_DIR } from "./paths.js";
import type { ShotsResult } from "./twelveLabs.js";

export interface CacheEntry {
  analyzedAt: string;
  originalFilename: string;
  durationSeconds: number;
  /** The full Twelve Labs shots response, stored exactly as returned —
   *  never reshaped or lossily summarized, so a cache hit reconstructs
   *  the same AssetAnalysis a fresh call would via the same code path
   *  (see buildAssetAnalysis in index.ts). */
  analysisResult: ShotsResult;
}

type Manifest = Record<string, CacheEntry>;

// In-memory copy is the single source of truth once loaded — every read
// and write goes through this object, not the disk file directly. Because
// Node runs this module's code single-threaded, synchronous mutations to
// this object (setting manifest[hash] = entry) can never race with each
// other even when triggered from multiple concurrently-running uploads;
// only the actual disk flush needs serializing, which `persist()` below
// does via a promise-chain lock.
let manifest: Manifest | null = null;

async function loadManifest(): Promise<Manifest> {
  if (manifest) return manifest;
  try {
    const raw = await fs.readFile(ANALYSIS_MANIFEST_PATH, "utf8");
    manifest = JSON.parse(raw) as Manifest;
  } catch {
    // Missing file (first run) or corrupt JSON — start fresh rather than
    // crashing the server over a cache file. A corrupt manifest is
    // overwritten on the next successful analysis anyway.
    manifest = {};
  }
  return manifest;
}

// Serializes disk writes so two cache misses resolving around the same
// time (realistic given the concurrency-bounded upload pipeline) don't
// interleave two `writeFile` calls — each write always persists the
// complete current in-memory manifest, so queuing them is sufficient;
// there's nothing to merge because the in-memory object already has
// every entry added so far.
let writeQueue: Promise<void> = Promise.resolve();

async function persist(): Promise<void> {
  const snapshot = manifest ?? {};
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const tmpPath = `${ANALYSIS_MANIFEST_PATH}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2), "utf8");
    // rename() is atomic on the same filesystem — a crash mid-write
    // leaves the old manifest intact, never a half-written one.
    await fs.rename(tmpPath, ANALYSIS_MANIFEST_PATH);
  });
  await writeQueue;
}

export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export async function getCachedAnalysis(hash: string): Promise<CacheEntry | undefined> {
  const m = await loadManifest();
  return m[hash];
}

export async function setCachedAnalysis(hash: string, entry: CacheEntry): Promise<void> {
  const m = await loadManifest();
  m[hash] = entry;
  await persist();
}

// NOTE: entries are kept forever — no TTL/eviction yet. Once the manifest
// grows large (many distinct source videos analyzed over time), consider
// an eviction policy (LRU by analyzedAt, a max entry count, or a max file
// size with oldest-first pruning). Not needed yet; don't build it early.
