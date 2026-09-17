import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, "..");
export const UPLOADS_DIR = path.join(SERVER_ROOT, "data", "uploads");
export const RENDERS_DIR = path.join(SERVER_ROOT, "data", "renders");
export const TMP_DIR = path.join(SERVER_ROOT, "data", "tmp");
// Repo-root-relative rather than hardcoded to a specific home directory —
// resolves to exactly `~/Documents/pbandj/cache` for this checkout, but
// doesn't assume any particular username or that the repo lives under
// Documents at all. Deliberately a sibling of `server/`, not under
// `server/data/`: this must survive being wiped for a "clean slate" reset
// of uploads/renders between test sessions.
export const CACHE_DIR = path.join(SERVER_ROOT, "..", "cache");
export const ANALYSIS_MANIFEST_PATH = path.join(CACHE_DIR, "twelvelabs-analysis.json");
// Style-training submissions are a separate, longer-lived corpus from
// regular one-off render-job uploads (UPLOADS_DIR gets wiped between test
// sessions; this must not be). Kept under CACHE_DIR for the same
// survives-a-reset reason ANALYSIS_MANIFEST_PATH is.
export const TRAINING_DIR = path.join(CACHE_DIR, "training");
export const TRAINING_FILES_DIR = path.join(TRAINING_DIR, "files");
export const TRAINING_MANIFEST_PATH = path.join(TRAINING_DIR, "projects.json");
export const LEARNED_ADJUSTMENTS_PATH = path.join(TRAINING_DIR, "learned-adjustments.json");
// A signed-in creator's actual saved edits (Dashboard's recent-activity
// list) — separate from TRAINING_MANIFEST_PATH's style-training corpus.
// Lives at CACHE_DIR's top level for the same survives-a-reset reason as
// ANALYSIS_MANIFEST_PATH.
export const PROJECTS_MANIFEST_PATH = path.join(CACHE_DIR, "projects.json");

for (const dir of [UPLOADS_DIR, RENDERS_DIR, TMP_DIR, CACHE_DIR, TRAINING_DIR, TRAINING_FILES_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
