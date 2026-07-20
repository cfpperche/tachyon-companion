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
 * Mobile bottom-nav tab list (equal columns, icon + label).
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
}: {
  value: string;
  children?: ComponentChildren;
  /** Optional leading icon (shown above the label on mobile bottom nav). */
  icon?: ComponentChildren;
}) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5",
        "text-[10px] font-semibold leading-tight tracking-wide",
        "text-[var(--tc-text-muted)] transition-colors",
        "data-[state=active]:text-[var(--tc-accent)]",
        "focus-visible:outline-none focus-visible:shadow-[var(--tc-focus)]",
        "hover:text-[var(--tc-text)]",
      )}
    >
      {icon ? (
        <span className="flex h-5 w-5 items-center justify-center opacity-90 [&_svg]:h-[18px] [&_svg]:w-[18px]" aria-hidden>
          {icon}
        </span>
      ) : null}
      <span className="truncate">{children}</span>
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
