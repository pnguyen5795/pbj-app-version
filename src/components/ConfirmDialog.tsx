import "./ConfirmDialog.css";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="pbj-confirm-backdrop" onClick={onCancel}>
      <div className="pbj-confirm" onClick={(e) => e.stopPropagation()} role="alertdialog">
        <h2 className="pbj-confirm__title">{title}</h2>
        <p className="pbj-confirm__message">{message}</p>
        <div className="pbj-confirm__actions">
          <button type="button" className="pbj-confirm__btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={
              "pbj-confirm__btn pbj-confirm__btn--primary" +
              (destructive ? " pbj-confirm__btn--destructive" : "")
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
