import type { ReactNode } from "react";
import { BackButton } from "./BackButton";
import "./TopBar.css";

interface TopBarProps {
  title?: string;
  onBack?: () => void;
  right?: ReactNode;
}

export function TopBar({ title, onBack, right }: TopBarProps) {
  return (
    <header className="pbj-topbar">
      <div className="pbj-topbar__side">{onBack && <BackButton onClick={onBack} />}</div>
      {title && <h1 className="pbj-topbar__title">{title}</h1>}
      <div className="pbj-topbar__side pbj-topbar__side--right">{right}</div>
    </header>
  );
}
