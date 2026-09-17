import { apiBase, apiFetch } from "./apiBase";

/** A real saved edit for the signed-in user — backs the Dashboard's
 *  recent-activity list. Never sourced from mockProjects.ts. */
export interface DashboardProject {
  id: string;
  name: string;
  createdAt: string;
  durationSec: number;
  videoUrl: string;
}

export async function listRecentProjects(): Promise<DashboardProject[]> {
  const res = await apiFetch("/api/projects");
  const body: { projects: DashboardProject[] } = await res.json();
  return body.projects.map((p) => ({ ...p, videoUrl: `${apiBase()}${p.videoUrl}` }));
}
