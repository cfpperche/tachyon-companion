import type { ComponentChildren } from "preact";
import { cn } from "../cn.js";
import { Badge, type BadgeTone } from "./Badge.js";

export interface StatusHeaderProps {
  title: string;
  subtitle?: string;
  statusLabel: string;
  statusTone?: BadgeTone;
  actions?: ComponentChildren;
  className?: string;
}

export function StatusHeader({
  title,
  subtitle,
  statusLabel,
  statusTone = "neutral",
  actions,
  className,
}: StatusHeaderProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-10 flex items-start justify-between gap-3",
        "border-b border-[var(--tc-border)] bg-[color-mix(in_srgb,var(--tc-bg-elevated)_88%,var(--tc-bg))]",
        "px-3.5 py-3 backdrop-blur-sm",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div
          className="h-7 w-7 shrink-0 rounded-[var(--tc-radius-sm)]"
          style={{ background: "linear-gradient(145deg, var(--tc-accent), #9b7bff)" }}
          aria-hidden
        />
        <div className="min-w-0">
          <h1 className="m-0 truncate text-[var(--tc-text-lg)] font-bold text-[var(--tc-text)]">{title}</h1>
          {subtitle ? (
            <p className="m-0 truncate text-[var(--tc-text-xs)] text-[var(--tc-text-muted)]">{subtitle}</p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        <Badge tone={statusTone} dot>
          {statusLabel}
        </Badge>
      </div>
    </header>
  );
}
