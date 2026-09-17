import "./BackButton.css";

/**
 * The one back-button implementation in the app — gray circle + chevron,
 * 44x44 (meets the minimum tap target everywhere else uses too). Screens
 * are responsible for their own positioning (in-flow margin, or absolute
 * for screens whose content is otherwise vertically centered) — this
 * component only owns what the button itself looks like.
 */
export function BackButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={["pbj-back-btn", className ?? ""].filter(Boolean).join(" ")}
      onClick={onClick}
      aria-label="Back"
    >
      <svg width="11" height="18" viewBox="0 0 11 18" fill="none">
        <path
          d="M9.5 1.5L2 9L9.5 16.5"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
