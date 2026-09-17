import { Button } from "../components/Button";
import { COOKING_NARRATION } from "../data/placeholders";
import { useRenderProgress } from "../hooks/useRenderProgress";
import { useRotatingIndex } from "../hooks/useRotatingIndex";
import type { ActiveRender } from "../state/useAppFlow";
import "./Home.css";

const NARRATION_ROTATE_MS = 3000;

interface HomeProps {
  activeRenders: ActiveRender[];
  onNewProject: () => void;
  onOpenProjects: () => void;
  onOpenSettings: () => void;
  onOpenRender: (id: string) => void;
}

/**
 * Deliberately minimal, and deliberately the SAME on day one and day
 * ninety — the only thing that ever changes here is the in-progress
 * section, and that's driven by real shared render state now (see
 * useAppFlow's activeRenders), not a fake demo flag.
 */
export function Home({ activeRenders, onNewProject, onOpenProjects, onOpenSettings, onOpenRender }: HomeProps) {
  return (
    <div className="pbj-home">
      <button
        type="button"
        className="pbj-home__settings"
        onClick={onOpenSettings}
        aria-label="Settings"
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82A1.65 1.65 0 0 0 3 13.09H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 3.6a1.65 1.65 0 0 0 1-1.51V2a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 8a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div className="pbj-home__center">
        <img src="/sandwich-logo.png" alt="pb&j" className="pbj-home__mark" />

        {/* Absent entirely — no empty state — when nothing is rendering.
            One row per active render; a row disappears the instant its
            render completes (see useAppFlow's completion watcher), no
            "cleared" state to manage here. */}
        {activeRenders.length > 0 && (
          <div className="pbj-home__renders">
            {activeRenders.map((render) => (
              <HomeRenderRow key={render.id} render={render} onOpen={() => onOpenRender(render.id)} />
            ))}
          </div>
        )}

        <div className="pbj-home__actions">
          <Button fullWidth onClick={() => onNewProject()}>
            New Project
          </Button>
          <Button fullWidth variant="secondary" onClick={onOpenProjects}>
            My Projects
          </Button>
        </div>
      </div>
    </div>
  );
}

function HomeRenderRow({ render, onOpen }: { render: ActiveRender; onOpen: () => void }) {
  const progress = useRenderProgress(render);
  const narrationIndex = useRotatingIndex(COOKING_NARRATION.length, NARRATION_ROTATE_MS);

  return (
    <button type="button" className="pbj-home__render-row" onClick={onOpen}>
      <div className="pbj-home__render-top">
        <span className="pbj-home__render-title">{render.title}</span>
        <span className="pbj-home__render-percent">{progress}%</span>
      </div>
      <div className="pbj-home__render-track">
        <div className="pbj-home__render-fill" style={{ width: `${progress}%` }} />
      </div>
      <span className="pbj-home__render-status">{COOKING_NARRATION[narrationIndex]}</span>
    </button>
  );
}
