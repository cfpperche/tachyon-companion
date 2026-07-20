import type { JSX } from "preact";
import { cn } from "../cn.js";

export type TextareaProps = JSX.IntrinsicElements["textarea"] & {
  className?: string;
}

export function Textarea({ className, ...rest }: TextareaProps) {
  return (
    <textarea
      className={cn(
        "w-full min-h-[7rem] resize-y rounded-[var(--tc-radius-sm)] border border-[var(--tc-border)]",
        "bg-[var(--tc-bg-muted)] text-[var(--tc-text)] px-2.5 py-2",
        "text-[var(--tc-text-md)] placeholder:text-[var(--tc-text-muted)]",
        "focus-visible:outline-none focus-visible:shadow-[var(--tc-focus)]",
        "disabled:opacity-50 font-[var(--tc-font)]",
        className,
      )}
      {...rest}
    />
  );
}
