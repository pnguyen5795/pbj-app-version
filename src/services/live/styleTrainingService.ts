import type {
  StyleTrainingService,
  TrainingProject,
  TrainingProjectType,
  TrainingReviewSelection,
} from "../interfaces";
import { apiFetch } from "./apiBase";

export class LiveStyleTrainingService implements StyleTrainingService {
  async listProjects(): Promise<TrainingProject[]> {
    const res = await apiFetch("/api/training/projects");
    const body: { projects: TrainingProject[] } = await res.json();
    return body.projects;
  }

  async submit(type: TrainingProjectType, files: { final: File; raw?: File }): Promise<TrainingProject> {
    const formData = new FormData();
    formData.append("type", type);
    formData.append("final", files.final);
    if (files.raw) formData.append("raw", files.raw);

    const res = await apiFetch("/api/training/projects", { method: "POST", body: formData });
    const body: { project: TrainingProject } = await res.json();
    return body.project;
  }

  async review(id: string, decision: "approve" | "reject", selection?: TrainingReviewSelection): Promise<TrainingProject> {
    const res = await apiFetch(`/api/training/projects/${id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, ...selection }),
    });
    const body: { project: TrainingProject } = await res.json();
    return body.project;
  }
}
