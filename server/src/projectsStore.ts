import fs from "node:fs/promises";
import { CACHE_DIR, PROJECTS_MANIFEST_PATH } from "./paths.js";

/** A real completed edit, tied to the Clerk user who rendered it — the
 *  Dashboard's recent-activity list reads these, not mockProjects.ts. */
export interface SavedProject {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  durationSec: number;
  /** Relative path, e.g. "/api/renders/<id>/file" — same convention as
   *  every other asset/render URL in this API; the frontend prefixes it
   *  with apiBase(). */
  videoUrl: string;
}

type ProjectManifest = Record<string, SavedProject>;

// Same lazy-load / atomic-write / write-queue-lock pattern as
// trainingStore.ts / analysisCache.ts, duplicated rather than shared since
// each store holds unrelated data with an independent lifecycle.
let manifest: ProjectManifest | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function loadManifest(): Promise<ProjectManifest> {
  if (manifest) return manifest;
  try {
    const raw = await fs.readFile(PROJECTS_MANIFEST_PATH, "utf8");
    manifest = JSON.parse(raw) as ProjectManifest;
  } catch {
    manifest = {};
  }
  return manifest;
}

async function persistManifest(): Promise<void> {
  const snapshot = manifest ?? {};
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const tmpPath = `${PROJECTS_MANIFEST_PATH}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2), "utf8");
    await fs.rename(tmpPath, PROJECTS_MANIFEST_PATH);
  });
  await writeQueue;
}

export async function listProjectsForUser(userId: string): Promise<SavedProject[]> {
  const m = await loadManifest();
  return Object.values(m)
    .filter((p) => p.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveProject(project: SavedProject): Promise<void> {
  const m = await loadManifest();
  m[project.id] = project;
  await persistManifest();
}
