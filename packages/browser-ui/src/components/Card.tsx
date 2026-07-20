import type { ComponentChildren } from "preact";
import { cn } from "../cn.js";

export interface CardProps {
  children?: ComponentChildren;
  className?: string;
  title?: string;
  hint?: string;
  footer?: ComponentChildren;
}

export function Card({ children, className, title, hint, footer }: CardProps) {
  return (
    <section
      className={cn(
        "rounded-[var(--tc-radius-md)] border border-[var(--tc-border)]",
        "bg-[var(--tc-bg-elevated)] p-3 shadow-[var(--tc-shadow)]",
        className,
      )}
    >
      {title ? (
        <header className="mb-2.5">
          <h2 className="m-0 text-[var(--tc-text-xs)] font-bold uppercase tracking-wide text-[var(--tc-text-muted)]">
            {title}
          </h2>
          {hint ? <p className="m-0 mt-1 text-[var(--tc-text-xs)] text-[var(--tc-text-muted)]">{hint}</p> : null}
        </header>
      ) : null}
      <div>{children}</div>
      {footer ? <footer className="mt-3 flex flex-wrap gap-2">{footer}</footer> : null}
    </section>
  );
}
