import type { JSX } from "preact";
import { cn } from "../cn.js";

export type InputProps = JSX.IntrinsicElements["input"] & {
  className?: string;
};

export function Input({ className, ...rest }: InputProps) {
  return (
    <input
      className={cn(
        "w-full rounded-[var(--tc-radius-sm)] border border-[var(--tc-border)]",
        "bg-[var(--tc-bg-muted)] text-[var(--tc-text)] px-2.5 py-2",
        "text-[var(--tc-text-md)] placeholder:text-[var(--tc-text-muted)]",
        "focus-visible:outline-none focus-visible:shadow-[var(--tc-focus)]",
        "disabled:opacity-50",
        className,
      )}
      {...rest}
    />
  );
}
