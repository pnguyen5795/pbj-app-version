import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./Button.css";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = black fill (the one CTA a screen owns). secondary = white
   *  fill, bordered. text = no fill/border, quiet — for text-link-weight
   *  actions (dismiss, "cancel anyway", toggle links). */
  variant?: "primary" | "secondary" | "text";
  fullWidth?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "primary",
  fullWidth,
  icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    "pbj-btn",
    `pbj-btn--${variant}`,
    fullWidth ? "pbj-btn--full" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button className={classes} {...rest}>
      {icon && <span className="pbj-btn__icon">{icon}</span>}
      <span>{children}</span>
    </button>
  );
}
