// A tiny persistent (localStorage-backed) log of "a background batch
// finished" events, shared by every upload path in the app (Style
// Training and regular project uploads today). This exists specifically
// because real OS-level push notifications are not available here: the
// app is served over plain HTTP from a LAN IP (never HTTPS or
// localhost), and both the Notification API and the Push API require a
// secure context — neither can be offered on this origin without adding
// TLS, which is a real infrastructure change, not something app code can
// route around. This is the deliberate in-app fallback: a persistent
// record the creator sees next time they open the app, surviving a full
// page reload (unlike the in-memory batch stores), with a clear
// success/failure breakdown rather than a generic "done".
export interface AppNotification {
  id: string;
  kind: "styleTraining" | "upload";
  createdAt: string;
  total: number;
  succeeded: number;
  failed: number;
  seen: boolean;
}

const STORAGE_KEY = "pbj.notifications.v1";
const MAX_STORED = 30;

function load(): AppNotification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Corrupt data, or storage unavailable (private browsing, disabled
    // storage) — start fresh rather than crashing the app over this.
    return [];
  }
}

function persist(list: AppNotification[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_STORED)));
  } catch {
    // Storage full or unavailable — the in-memory copy still works for
    // the rest of this session, it just won't survive a reload.
  }
}

let notifications: AppNotification[] = load();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNotificationsSnapshot(): AppNotification[] {
  return notifications;
}

export function addNotification(input: {
  kind: AppNotification["kind"];
  total: number;
  succeeded: number;
  failed: number;
}): void {
  const entry: AppNotification = {
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    seen: false,
    ...input,
  };
  notifications = [entry, ...notifications];
  persist(notifications);
  emit();
}

export function markAllNotificationsSeen(): void {
  if (notifications.every((n) => n.seen)) return;
  notifications = notifications.map((n) => ({ ...n, seen: true }));
  persist(notifications);
  emit();
}

export function getUnseenNotificationCount(): number {
  return notifications.filter((n) => !n.seen).length;
}
