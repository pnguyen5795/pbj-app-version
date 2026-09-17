import { useCallback, useEffect, useRef, useState } from "react";
import {
  FAKE_COOKING_DURATION_MS,
  FAKE_PROJECTS,
  PROJECT_THUMB_GRADIENTS,
  type FakeProject,
} from "../data/placeholders";
import { formatTimestamp } from "../utils/format";

export type AppStage =
  | "yourStyle"
  | "teachIt"
  | "home"
  | "newProject"
  | "cooking"
  | "studio"
  | "projects"
  | "settings";

export interface UploadedClip {
  id: string;
  fileName: string;
  durationSec: number | null;
  thumbnailUrl: string | null;
}

export interface NewProjectDraft {
  title: string;
  clipCount: number;
  totalFootageSec: number;
  durationSec: number;
  durationCapMin: number;
  prompt: string;
  styleIds: string[];
  clips: UploadedClip[];
}

// A render that's currently in flight. Deliberately holds only what's
// needed to derive live progress (startedAt + durationMs) rather than a
// ticking percentage — every consumer (a Home row, the full Cooking
// screen) derives its own progress from this same timestamp independently,
// so no cross-component sync is needed and the render survives whichever
// of those screens happens to be mounted at a given moment.
export interface ActiveRender {
  id: string;
  title: string;
  prompt: string;
  styleIds: string[];
  startedAt: number;
  durationMs: number;
}

const ONBOARDED_KEY = "pbj_onboarded";
const ACTIVE_RENDERS_KEY = "pbj_active_renders";
const PROJECTS_KEY = "pbj_projects";

export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "true";
  } catch {
    return false;
  }
}

function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, "true");
  } catch {
    // Best-effort.
  }
}

export function clearOnboarded(): void {
  try {
    localStorage.removeItem(ONBOARDED_KEY);
  } catch {
    // Best-effort.
  }
}

// Renders and projects persist across a reload too, not just an in-app
// navigation — the closest thing a frontend-only prototype can do to
// honor "leave the app entirely and get notified when it's done" without
// a real backend actually driving the render server-side. A genuinely
// closed tab still stops the fake progress clock; only Paul's real
// backend can make that case truthful.
function loadActiveRenders(): ActiveRender[] {
  try {
    const raw = localStorage.getItem(ACTIVE_RENDERS_KEY);
    return raw ? (JSON.parse(raw) as ActiveRender[]) : [];
  } catch {
    return [];
  }
}

function saveActiveRenders(renders: ActiveRender[]): void {
  try {
    localStorage.setItem(ACTIVE_RENDERS_KEY, JSON.stringify(renders));
  } catch {
    // Best-effort.
  }
}

function loadProjects(): FakeProject[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    return raw ? (JSON.parse(raw) as FakeProject[]) : FAKE_PROJECTS;
  } catch {
    return FAKE_PROJECTS;
  }
}

function saveProjects(projects: FakeProject[]): void {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  } catch {
    // Best-effort.
  }
}

function makeRenderId(): string {
  return `render_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface AppFlow {
  stage: AppStage;
  newProjectDraft: NewProjectDraft | null;
  creatorStyles: string[];
  setCreatorStyles: (styles: string[]) => void;
  goToYourStyle: () => void;
  goToTeachIt: () => void;
  goToHome: () => void;
  // step=2 opens directly on the Recipe screen (New Project Screen 2) —
  // used by Cooking's "Edit Recipe" control, which per the task must not
  // detour through the clip-picker step. Omit for the normal step-1 entry.
  goToNewProject: (step?: 1 | 2) => void;
  newProjectInitialStep: 1 | 2;
  // Starts a brand-new render and navigates to its loading screen.
  goToCooking: (draft: NewProjectDraft) => void;
  goToStudio: (projectId?: string) => void;
  goToProjects: () => void;
  goToSettings: () => void;
  // Full render state, for the Home in-progress section and the
  // notification-routing stub.
  activeRenders: ActiveRender[];
  // Which render the Cooking screen should currently display.
  currentRenderId: string | null;
  // Which project Studio was opened for — used only to know which
  // project's unread flag to clear on first playback; Studio's own
  // content is not yet threaded per-project (still the mock timeline
  // for every existing project, unchanged from before this task).
  currentProjectId: string | null;
  // Opens an EXISTING render's loading screen without starting a new
  // one — Home row tap, My Projects row tap on an in-progress project,
  // or a notification deep-link to an in-progress render.
  openRender: (id: string) => void;
  // Destructively cancels an in-flight render — used by Cooking's Cancel
  // AND Edit Recipe confirm sheets (both routes are destructive per the
  // task spec's own framing; see Cooking.tsx).
  cancelRender: (id: string) => void;
  projects: FakeProject[];
  markProjectRead: (id: string) => void;
  renameProject: (id: string, title: string) => void;
  deleteProject: (id: string) => void;
}

export function useAppFlow(forceOnboarding = false): AppFlow {
  const [stage, setStage] = useState<AppStage>(() =>
    forceOnboarding || !hasOnboarded() ? "yourStyle" : "home"
  );
  const [newProjectDraft, setNewProjectDraft] = useState<NewProjectDraft | null>(null);
  const [creatorStyles, setCreatorStyles] = useState<string[]>([]);
  const [activeRenders, setActiveRenders] = useState<ActiveRender[]>(loadActiveRenders);
  const [projects, setProjects] = useState<FakeProject[]>(loadProjects);
  const [currentRenderId, setCurrentRenderId] = useState<string | null>(null);
  const [newProjectInitialStep, setNewProjectInitialStep] = useState<1 | 2>(1);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);

  useEffect(() => saveActiveRenders(activeRenders), [activeRenders]);
  useEffect(() => saveProjects(projects), [projects]);

  // Read inside the interval below without going in that effect's deps —
  // putting activeRenders there would tear down and rebuild the interval
  // (and its 1s cadence) on every single render completion.
  const activeRendersRef = useRef(activeRenders);
  useEffect(() => {
    activeRendersRef.current = activeRenders;
  }, [activeRenders]);

  // Always-mounted completion watcher — this is what lets a render finish
  // while the user is on Home, My Projects, or anywhere else, not just
  // while Cooking happens to be on screen. Polls rather than one-shot
  // setTimeouts per render so it stays correct across a reload (a
  // restored render's remaining time is derived fresh from startedAt,
  // not from a timer that no longer exists). setActiveRenders and
  // setProjects are called as two separate, side-effect-free updates —
  // NOT one nested inside the other's updater function — because React
  // (StrictMode especially) may invoke an updater function more than
  // once to verify it's pure; nesting a second setState inside the first
  // one's updater duplicated every completed render the first time this
  // was built this way.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const finished = activeRendersRef.current.filter(
        (render) => now - render.startedAt >= render.durationMs
      );
      if (finished.length === 0) return;
      setActiveRenders((renders) => renders.filter((r) => !finished.includes(r)));
      setProjects((prev) => [
        ...finished.map((render, i) => ({
          id: render.id,
          title: render.title,
          durationLabel: formatTimestamp(
            // Falls back to a plausible label when a draft's own duration
            // wasn't carried onto the render — every real path sets this.
            render.durationMs > 0 ? Math.round(render.durationMs / 1000 / 6) : 30
          ),
          thumbGradient: PROJECT_THUMB_GRADIENTS[(prev.length + i) % PROJECT_THUMB_GRADIENTS.length],
          unread: true,
        })),
        ...prev,
      ]);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const goToYourStyle = useCallback(() => setStage("yourStyle"), []);
  const goToTeachIt = useCallback(() => setStage("teachIt"), []);
  const goToHome = useCallback(() => {
    markOnboarded();
    setStage("home");
  }, []);
  const goToNewProject = useCallback((step?: 1 | 2) => {
    setNewProjectInitialStep(step ?? 1);
    setStage("newProject");
  }, []);

  const goToCooking = useCallback((draft: NewProjectDraft) => {
    setNewProjectDraft(draft);
    const id = makeRenderId();
    const render: ActiveRender = {
      id,
      title: draft.title,
      prompt: draft.prompt,
      styleIds: draft.styleIds,
      startedAt: Date.now(),
      durationMs: FAKE_COOKING_DURATION_MS,
    };
    setActiveRenders((renders) => [...renders, render]);
    setCurrentRenderId(id);
    setStage("cooking");
  }, []);

  const openRender = useCallback((id: string) => {
    setCurrentRenderId(id);
    setStage("cooking");
  }, []);

  const cancelRender = useCallback((id: string) => {
    setActiveRenders((renders) => renders.filter((r) => r.id !== id));
  }, []);

  const goToStudio = useCallback((projectId?: string) => {
    setCurrentProjectId(projectId ?? null);
    setStage("studio");
  }, []);

  const goToProjects = useCallback(() => {
    setNewProjectDraft(null);
    setStage("projects");
  }, []);

  const goToSettings = useCallback(() => setStage("settings"), []);

  const markProjectRead = useCallback((id: string) => {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, unread: false } : p)));
  }, []);

  const renameProject = useCallback((id: string, title: string) => {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, title } : p)));
  }, []);

  const deleteProject = useCallback((id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return {
    stage,
    newProjectDraft,
    creatorStyles,
    setCreatorStyles,
    goToYourStyle,
    goToTeachIt,
    goToHome,
    goToNewProject,
    goToCooking,
    goToStudio,
    goToProjects,
    goToSettings,
    newProjectInitialStep,
    activeRenders,
    currentRenderId,
    currentProjectId,
    openRender,
    cancelRender,
    projects,
    markProjectRead,
    renameProject,
    deleteProject,
  };
}
