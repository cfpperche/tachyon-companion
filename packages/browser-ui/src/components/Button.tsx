import type { ComponentChildren, JSX } from "preact";
import { cn } from "../cn.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, "size"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ComponentChildren;
  className?: string;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--tc-accent)] text-[var(--tc-accent-fg)] hover:bg-[var(--tc-accent-hover)] border border-transparent",
  secondary:
    "bg-[var(--tc-bg-muted)] text-[var(--tc-text)] border border-[var(--tc-border)] hover:brightness-105",
  ghost:
    "bg-transparent text-[var(--tc-text-muted)] border border-[var(--tc-border)] hover:text-[var(--tc-text)] hover:bg-[var(--tc-bg-muted)]",
  danger:
    "bg-[var(--tc-danger-muted)] text-[var(--tc-danger)] border border-transparent hover:brightness-110",
};

const sizes: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1.5 text-[var(--tc-text-sm)] min-h-8",
  md: "px-3 py-2 text-[var(--tc-text-md)] min-h-10",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  type = "button",
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-[var(--tc-radius-sm)] font-semibold",
        "transition-[filter,background-color,color] cursor-pointer",
        "focus-visible:outline-none focus-visible:shadow-[var(--tc-focus)]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
