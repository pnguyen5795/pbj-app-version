// Stand-in for Paul's real auth/session system. This file exists only to
// answer one question — "does this device already have a signed-in
// session from a previous visit?" — for the dev-bypass path, which has
// no real backend session of its own to check (real Clerk sign-in
// already persists itself via Clerk's own SDK and needs nothing here).
//
// SWAP POINT: when Paul's own auth lands, replace the three functions
// below with whatever his system provides — typically a session-validity
// check, a login callback, and a logout call — and delete this file.
// The only two call sites are in App.tsx: the boot-time check and the
// sign-out handler. Nothing else in the app imports this module.
const SIGNED_IN_KEY = "pbj_dev_bypass_signed_in";

export function getPersistedSignIn(): boolean {
  try {
    return localStorage.getItem(SIGNED_IN_KEY) === "true";
  } catch {
    return false;
  }
}

export function persistSignIn(): void {
  try {
    localStorage.setItem(SIGNED_IN_KEY, "true");
  } catch {
    // Best-effort — worst case the user has to dev-bypass again next launch.
  }
}

export function persistSignOut(): void {
  try {
    localStorage.removeItem(SIGNED_IN_KEY);
  } catch {
    // no-op
  }
}
