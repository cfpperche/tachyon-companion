import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentChildren } from "preact";
import { cn } from "../cn.js";

export function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  children?: ComponentChildren;
  className?: string;
}) {
  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      {children}
    </TabsPrimitive.Root>
  );
}

/**
 * Mobile bottom-nav tab list (equal columns, icon-only + title hint).
 * Place after TabsContent so it pins to the bottom of the flex column.
 */
export function TabsList({ children, className }: { children?: ComponentChildren; className?: string }) {
  return (
    <TabsPrimitive.List
      className={cn(
        "mt-auto flex shrink-0 items-stretch border-t border-[var(--tc-border)]",
        "bg-[color-mix(in_srgb,var(--tc-bg-elevated)_92%,var(--tc-bg))]",
        "px-1 pb-[max(0.35rem,env(safe-area-inset-bottom))] pt-1",
        className,
      )}
    >
      {children}
    </TabsPrimitive.List>
  );
}

export function TabsTrigger({
  value,
  children,
  icon,
  hint,
}: {
  value: string;
  /** @deprecated Prefer `hint` — children used as tooltip when `hint` omitted. */
  children?: ComponentChildren;
  icon?: ComponentChildren;
  /** Tooltip / accessible name (native title + aria-label). */
  hint?: string;
}) {
  const label =
    hint ??
    (typeof children === "string" || typeof children === "number" ? String(children) : undefined);

  return (
    <TabsPrimitive.Trigger
      value={value}
      title={label}
      aria-label={label}
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center justify-center rounded-md px-1 py-2.5",
        "text-[var(--tc-text-muted)] transition-colors",
        "data-[state=active]:text-[var(--tc-accent)]",
        "focus-visible:outline-none focus-visible:shadow-[var(--tc-focus)]",
        "hover:text-[var(--tc-text)]",
      )}
    >
      {icon ? (
        <span className="flex h-6 w-6 items-center justify-center opacity-90 [&_svg]:h-5 [&_svg]:w-5" aria-hidden>
          {icon}
        </span>
      ) : (
        <span className="truncate text-[10px] font-semibold">{children}</span>
      )}
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({ value, children, className }: { value: string; children?: ComponentChildren; className?: string }) {
  return (
    <TabsPrimitive.Content
      value={value}
      className={cn("min-h-0 flex-1 overflow-auto outline-none data-[state=inactive]:hidden", className)}
    >
      {children}
    </TabsPrimitive.Content>
  );
}
