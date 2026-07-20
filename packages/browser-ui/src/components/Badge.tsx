import type { ComponentChildren } from "preact";
import { cn } from "../cn.js";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "working";

export interface BadgeProps {
  tone?: BadgeTone;
  dot?: boolean;
  children?: ComponentChildren;
  className?: string;
}

const tones: Record<BadgeTone, string> = {
  neutral: "bg-[var(--tc-bg-muted)] text-[var(--tc-text-muted)]",
  success: "bg-[var(--tc-success-muted)] text-[var(--tc-success)]",
  warning: "bg-[var(--tc-warning-muted)] text-[var(--tc-warning)]",
  danger: "bg-[var(--tc-danger-muted)] text-[var(--tc-danger)]",
  info: "bg-[var(--tc-info-muted)] text-[var(--tc-info)]",
  working: "bg-[var(--tc-working-muted)] text-[var(--tc-working)]",
};

const dotColor: Record<BadgeTone, string> = {
  neutral: "bg-[var(--tc-text-muted)]",
  success: "bg-[var(--tc-success)]",
  warning: "bg-[var(--tc-warning)]",
  danger: "bg-[var(--tc-danger)]",
  info: "bg-[var(--tc-info)]",
  working: "bg-[var(--tc-working)]",
};

export function Badge({ tone = "neutral", dot, children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--tc-radius-pill)]",
        "px-2 py-0.5 text-[var(--tc-text-xs)] font-semibold capitalize",
        "border border-[var(--tc-border)]",
        tones[tone],
        className,
      )}
    >
      {dot ? <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", dotColor[tone])} /> : null}
      {children}
    </span>
  );
}
