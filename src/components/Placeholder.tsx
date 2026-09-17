import type { ReactNode } from "react";
import "./Placeholder.css";

/**
 * Marks a value sourced from src/data/placeholders.ts as fake — previously
 * a purple dashed outline + tint, now a no-op wrapper (that flag styling
 * was pulled app-wide in the purple sweep; see Placeholder.css). Kept as a
 * component so call sites still read as "this is stand-in data" and so
 * reintroducing a visible (non-purple) flag later is a one-file change.
 */
export function Placeholder({
  children,
  inline,
  className,
}: {
  children: ReactNode;
  inline?: boolean;
  className?: string;
}) {
  const Tag = inline ? "span" : "div";
  return (
    <Tag
      className={[
        "pbj-placeholder",
        inline ? "pbj-placeholder--inline" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </Tag>
  );
}
