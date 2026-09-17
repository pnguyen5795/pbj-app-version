// The backend always runs on the same host as whatever served this page —
// localhost for you, your LAN IP for a friend's phone that loaded the app
// from http://<your-ip>:5173 — just on a different port. Computing it from
// location.hostname (rather than hardcoding an IP) means the app works
// identically for every device on the network without configuration.
const SERVER_PORT = 4000;

export function apiBase(): string {
  return `${window.location.protocol}//${window.location.hostname}:${SERVER_PORT}`;
}

interface FailureDetail {
  fileName?: string;
  message: string;
}

// The service layer (uploadClient, ffmpegRenderService, projectsService,
// ...) is a set of plain functions, not React components/hooks — they
// can't call useAuth() to get a session token. ClerkProvider exposes the
// same client imperatively as window.Clerk once loaded, which is the
// supported way to reach a token from non-component code. Declared here
// rather than pulling in a full @clerk/clerk-js type dependency for one
// narrow use.
declare global {
  interface Window {
    Clerk?: { session?: { getToken(): Promise<string | null> } };
  }
}

async function authHeaders(): Promise<HeadersInit> {
  const token = await window.Clerk?.session?.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { ...(await authHeaders()), ...init?.headers },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
      // Some endpoints (e.g. /api/understand when every clip failed)
      // include a per-item breakdown — surface exactly which file failed
      // and why instead of just the generic top-level message.
      const failures: FailureDetail[] | undefined = body?.failures;
      if (Array.isArray(failures) && failures.length > 0) {
        message += ": " + failures.map((f) => `${f.fileName ?? "a clip"} — ${f.message}`).join("; ");
      }
    } catch {
      // response wasn't JSON — keep the status text
    }
    throw new Error(message);
  }
  return res;
}
