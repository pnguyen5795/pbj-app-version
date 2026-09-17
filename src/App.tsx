import { useEffect, useState } from "react";
import { useAuth, useClerk } from "@clerk/clerk-react";
import { Splash } from "./screens/Splash";
import { SignIn } from "./screens/SignIn";
import { YourStyle } from "./screens/YourStyle";
import { TeachIt } from "./screens/TeachIt";
import { Home } from "./screens/Home";
import { NewProject } from "./screens/NewProject";
import { Cooking } from "./screens/Cooking";
import { Studio } from "./screens/Studio";
import { ExistingProjects } from "./screens/ExistingProjects";
import { Settings } from "./screens/Settings";
import { useAppFlow, clearOnboarded, type AppFlow } from "./state/useAppFlow";
import { getPersistedSignIn, persistSignIn, persistSignOut } from "./state/authSession";

function App() {
  // Persisted across reloads and full app relaunches (see authSession.ts)
  // — the dev-bypass equivalent of a real Clerk session, which persists
  // itself. Read once, synchronously, at mount: this is what lets a
  // returning dev-bypass session skip Splash/Sign In with no flash (see
  // splashDone's own initializer below), since we don't have to wait on
  // anything async to know the answer.
  const [devBypass, setDevBypass] = useState(() => getPersistedSignIn());
  // One-shot and NEVER persisted — true only for the render right after a
  // *fresh* dev-bypass click in this page load, as opposed to `devBypass`
  // itself (which stays true across reloads once persisted). Onboarding
  // must force-show on a fresh bypass click but not on a restored bypass
  // session that already finished it — see useAppFlow's forceOnboarding
  // doc comment for why a stale-flag mismatch matters here.
  const [justDevBypassed, setJustDevBypassed] = useState(false);
  // Starts true (skipping Splash outright) when a persisted dev-bypass
  // session already exists — otherwise the usual first-boot behavior.
  const [splashDone, setSplashDone] = useState(() => devBypass);
  // Set only when THIS mount just completed a real email sign-up — lets
  // AuthenticatedApp force the "your style"/"teach it" first-run flow even
  // if this browser's stale onboarding flag says otherwise (see
  // useAppFlow's forceOnboarding doc).
  const [justSignedUp, setJustSignedUp] = useState(false);
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut: clerkSignOut } = useClerk();

  function handleDevBypass() {
    persistSignIn();
    setDevBypass(true);
    setJustDevBypassed(true);
  }

  // The single sign-out path for both auth modes this prototype has —
  // dev bypass and real Clerk — so Settings' "Sign Out" button always
  // fully resets state regardless of which one is active. Per spec, this
  // is the ONLY thing that returns the user to the start of the flow:
  // clears the persisted auth flag, the onboarding flag, and replays
  // Splash on the next render.
  async function handleSignOut() {
    persistSignOut();
    clearOnboarded();
    setDevBypass(false);
    setJustDevBypassed(false);
    setJustSignedUp(false);
    setSplashDone(false);
    if (isSignedIn) {
      await clerkSignOut();
    }
  }

  // devBypass resolves synchronously; real Clerk sign-in still needs
  // isLoaded to resolve asynchronously. Neither Splash nor Sign In should
  // render while that's genuinely still unknown — only this blank frame
  // should, and only for however briefly Clerk takes to answer.
  if (!devBypass && !isLoaded) {
    return <div className="pbj-auth-loading" aria-hidden="true" />;
  }

  if (devBypass || isSignedIn) {
    return <AuthenticatedApp forceOnboarding={justDevBypassed || justSignedUp} onSignOut={handleSignOut} />;
  }

  if (!splashDone) {
    return <Splash onDone={() => setSplashDone(true)} />;
  }

  return <SignIn onDevBypass={handleDevBypass} onSignUpComplete={() => setJustSignedUp(true)} />;
}

// The one screen whose data doesn't come from a simple flow.<field> read —
// it has to find its own render (by id, out of possibly several active
// ones) and handle the "no longer exists" case (completed or cancelled
// while the creator was elsewhere) before it can render anything.
// Redirecting home is a side effect, so it has to happen in an effect,
// not during render — hence this being its own component rather than a
// branch inline in AuthenticatedApp's switch.
function CookingRoute({ flow }: { flow: AppFlow }) {
  const render = flow.activeRenders.find((r) => r.id === flow.currentRenderId);

  // flow.goToHome is stable (useCallback, empty deps) — depending on the
  // whole flow object here would refire this on every unrelated state
  // change (e.g. a different render's progress ticking), since useAppFlow
  // returns a fresh object every render.
  useEffect(() => {
    if (!render) flow.goToHome();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render, flow.goToHome]);

  if (!render) return null;

  return (
    <Cooking
      render={render}
      onBack={flow.goToHome}
      onCancel={() => {
        flow.cancelRender(render.id);
        flow.goToHome();
      }}
      onEdit={() => {
        flow.cancelRender(render.id);
        flow.goToNewProject(2);
      }}
      onComplete={() => flow.goToStudio(render.id)}
    />
  );
}

function AuthenticatedApp({
  forceOnboarding,
  onSignOut,
}: {
  forceOnboarding: boolean;
  onSignOut: () => void;
}) {
  const flow = useAppFlow(forceOnboarding);
  return renderScreen(flow, onSignOut);
}

function renderScreen(flow: AppFlow, onSignOut: () => void) {
  switch (flow.stage) {
    case "yourStyle":
      return (
        <YourStyle
          onDone={(selected) => {
            flow.setCreatorStyles(selected);
            flow.goToTeachIt();
          }}
        />
      );

    case "teachIt":
      return <TeachIt onBack={flow.goToYourStyle} onDone={() => flow.goToHome()} />;

    case "home":
      return (
        <Home
          activeRenders={flow.activeRenders}
          onNewProject={flow.goToNewProject}
          onOpenProjects={flow.goToProjects}
          onOpenSettings={flow.goToSettings}
          onOpenRender={flow.openRender}
        />
      );

    case "newProject":
      return (
        <NewProject
          initialDraft={flow.newProjectDraft}
          initialStep={flow.newProjectInitialStep}
          onBack={flow.goToHome}
          onSubmit={flow.goToCooking}
        />
      );

    case "cooking":
      return <CookingRoute flow={flow} />;

    case "studio":
      return (
        <Studio
          onBack={flow.goToHome}
          initialClips={flow.newProjectDraft?.clips ?? []}
          creatorStyles={flow.creatorStyles}
          prompt={flow.newProjectDraft?.prompt ?? ""}
          styleIds={flow.newProjectDraft?.styleIds ?? []}
          onFirstPlay={
            flow.currentProjectId ? () => flow.markProjectRead(flow.currentProjectId!) : undefined
          }
        />
      );

    case "projects":
      return (
        <ExistingProjects
          projects={flow.projects}
          onBack={flow.goToHome}
          onOpenProject={flow.goToStudio}
          onRenameProject={flow.renameProject}
          onDeleteProject={flow.deleteProject}
        />
      );

    case "settings":
      return <Settings onBack={flow.goToHome} onSignOut={onSignOut} />;
  }
}

export default App;
