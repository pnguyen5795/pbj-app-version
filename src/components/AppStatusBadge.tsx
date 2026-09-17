import { useState, useSyncExternalStore } from "react";
import {
  subscribeTrainingBatches,
  getTrainingBatchesSnapshot,
  totalPendingCount as trainingPendingCount,
  totalItemCount as trainingTotalCount,
} from "../state/trainingBatchStore";
import {
  subscribeMediaUploads,
  getMediaUploadsSnapshot,
  totalPendingUploadCount,
  totalUploadItemCount,
} from "../state/mediaUploadStore";
import {
  subscribeNotifications,
  getNotificationsSnapshot,
  getUnseenNotificationCount,
  markAllNotificationsSeen,
  type AppNotification,
} from "../state/notificationCenter";
import { Button } from "./Button";
import "./AppStatusBadge.css";

function NotificationPanel({ notifications, onClose }: { notifications: AppNotification[]; onClose: () => void }) {
  return (
    <div className="pbj-status-panel-backdrop" onClick={onClose}>
      <div className="pbj-status-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pbj-status-panel__handle" />
        <h2 className="pbj-status-panel__title">updates</h2>
        <div className="pbj-status-panel__list">
          {notifications.length === 0 && <p className="pbj-status-panel__empty">Nothing yet.</p>}
          {notifications.slice(0, 20).map((n) => (
            <div key={n.id} className="pbj-status-panel__row">
              <span className="pbj-status-panel__kind">
                {n.kind === "styleTraining" ? "style training" : "upload"}
              </span>
              <span className="pbj-status-panel__summary">
                {n.succeeded} done{n.failed > 0 ? `, ${n.failed} failed` : ""} of {n.total}
              </span>
              <span className="pbj-status-panel__time">{new Date(n.createdAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
        <Button fullWidth onClick={onClose}>
          close
        </Button>
      </div>
    </div>
  );
}

/**
 * Mounted once at the app root (see App.tsx), outside the screen switch,
 * so it stays visible regardless of which screen is active. Real OS push
 * notifications aren't available here (this app is served over plain
 * HTTP from a LAN IP, never a secure context, and there's no service
 * worker or push infrastructure) — this is the in-app fallback: a live
 * "still working" indicator while something's running, and a persistent,
 * success/failure-aware record of what finished, survives a full page
 * reload via notificationCenter.ts's localStorage backing.
 */
export function AppStatusBadge({
  onOpenStyleTraining,
  onOpenSetup,
}: {
  onOpenStyleTraining: () => void;
  onOpenSetup: () => void;
}) {
  useSyncExternalStore(subscribeTrainingBatches, getTrainingBatchesSnapshot);
  useSyncExternalStore(subscribeMediaUploads, getMediaUploadsSnapshot);
  const notifications = useSyncExternalStore(subscribeNotifications, getNotificationsSnapshot);
  const [panelOpen, setPanelOpen] = useState(false);

  const trainingPending = trainingPendingCount();
  const uploadPending = totalPendingUploadCount();
  const unseenCount = getUnseenNotificationCount();

  if (trainingPending > 0) {
    return (
      <button type="button" className="pbj-status-badge" onClick={onOpenStyleTraining}>
        <span className="pbj-status-badge__spinner" />
        training: {trainingTotalCount() - trainingPending}/{trainingTotalCount()} processing
      </button>
    );
  }

  if (uploadPending > 0) {
    return (
      <button type="button" className="pbj-status-badge" onClick={onOpenSetup}>
        <span className="pbj-status-badge__spinner" />
        uploading: {totalUploadItemCount() - uploadPending}/{totalUploadItemCount()}
      </button>
    );
  }

  if (unseenCount > 0) {
    return (
      <>
        <button
          type="button"
          className="pbj-status-badge pbj-status-badge--notify"
          onClick={() => setPanelOpen(true)}
        >
          🔔 {unseenCount} update{unseenCount === 1 ? "" : "s"}
        </button>
        {panelOpen && (
          <NotificationPanel
            notifications={notifications}
            onClose={() => {
              markAllNotificationsSeen();
              setPanelOpen(false);
            }}
          />
        )}
      </>
    );
  }

  return null;
}
