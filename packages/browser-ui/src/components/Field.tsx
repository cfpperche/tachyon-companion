import type { ComponentChildren } from "preact";
import { cn } from "../cn.js";

export interface FieldProps {
  label: string;
  children?: ComponentChildren;
  className?: string;
  hint?: string;
}

export function Field({ label, children, className, hint }: FieldProps) {
  return (
    <label className={cn("mb-2.5 grid gap-1 text-[var(--tc-text-xs)] text-[var(--tc-text-muted)]", className)}>
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="text-[10px] opacity-90">{hint}</span> : null}
    </label>
  );
}
