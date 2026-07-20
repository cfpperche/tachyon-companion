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
    <TabsPrimitive.Root value={value} onValueChange={onValueChange} className={cn("flex flex-col gap-3", className)}>
      {children}
    </TabsPrimitive.Root>
  );
}

export function TabsList({ children, className }: { children?: ComponentChildren; className?: string }) {
  return (
    <TabsPrimitive.List
      className={cn(
        "flex gap-1 overflow-x-auto rounded-[var(--tc-radius-sm)] border border-[var(--tc-border)]",
        "bg-[var(--tc-bg-muted)] p-1",
        className,
      )}
    >
      {children}
    </TabsPrimitive.List>
  );
}

export function TabsTrigger({ value, children }: { value: string; children?: ComponentChildren }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        "shrink-0 rounded-md px-2.5 py-1.5 text-[var(--tc-text-xs)] font-semibold",
        "text-[var(--tc-text-muted)] transition-colors",
        "data-[state=active]:bg-[var(--tc-bg-elevated)] data-[state=active]:text-[var(--tc-text)]",
        "data-[state=active]:shadow-[var(--tc-shadow)]",
        "focus-visible:outline-none focus-visible:shadow-[var(--tc-focus)]",
      )}
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({ value, children, className }: { value: string; children?: ComponentChildren; className?: string }) {
  return (
    <TabsPrimitive.Content value={value} className={cn("outline-none", className)}>
      {children}
    </TabsPrimitive.Content>
  );
}
