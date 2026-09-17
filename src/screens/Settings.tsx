import { useUser } from "@clerk/clerk-react";
import { TopBar } from "../components/TopBar";
import { Button } from "../components/Button";
import { UsageMeter } from "../components/UsageMeter";
import "./Settings.css";

/** Up to 2 letters from a name, or the local part of an email if there's no
 *  name (sign-up no longer collects one — see SignIn.tsx). Never falls back
 *  to a bare "?": that reads as a broken image, not an avatar. */
function getInitials(fullName: string, email: string): string {
  const source = fullName.trim() || email.split("@")[0] || "";
  if (!source) return "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export function Settings({ onBack, onSignOut }: { onBack: () => void; onSignOut: () => void }) {
  const { user } = useUser();

  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const initials = getInitials(user?.fullName ?? "", email);

  return (
    <div className="pbj-settings">
      <TopBar onBack={onBack} />

      <div className="pbj-settings__body">
        <div className="pbj-settings__hero">
          <h1 className="pbj-settings__hero-title">Your Account</h1>
          <p className="pbj-settings__hero-sub">Manage Your Plan and Sign Out</p>
        </div>

        <div className="pbj-settings__avatar-row">
          {user?.imageUrl ? (
            <img src={user.imageUrl} alt="" className="pbj-settings__avatar-img" />
          ) : initials ? (
            <div className="pbj-settings__avatar">{initials}</div>
          ) : (
            <div className="pbj-settings__avatar" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="8" r="4" fill="currentColor" />
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" fill="currentColor" />
              </svg>
            </div>
          )}
          <div>
            {user?.fullName && <div className="pbj-settings__name">{user.fullName}</div>}
            <span className="pbj-settings__email">{email}</span>
          </div>
        </div>

        <UsageMeter />

        <Button variant="secondary" fullWidth onClick={onSignOut}>
          Sign Out
        </Button>
      </div>
    </div>
  );
}
