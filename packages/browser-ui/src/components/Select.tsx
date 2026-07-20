import * as SelectPrimitive from "@radix-ui/react-select";
import type { ComponentChildren } from "preact";
import { cn } from "../cn.js";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  disabled,
  className,
}: SelectProps) {
  return (
    <SelectPrimitive.Root value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-[var(--tc-radius-sm)]",
          "border border-[var(--tc-border)] bg-[var(--tc-bg-muted)] px-2.5 py-2",
          "text-left text-[var(--tc-text-md)] text-[var(--tc-text)]",
          "focus-visible:outline-none focus-visible:shadow-[var(--tc-focus)]",
          "disabled:opacity-50 min-h-10",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="text-[var(--tc-text-muted)] text-xs">▾</SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className={cn(
            "z-50 overflow-hidden rounded-[var(--tc-radius-sm)] border border-[var(--tc-border)]",
            "bg-[var(--tc-bg-elevated)] text-[var(--tc-text)] shadow-lg",
            "max-h-60 min-w-[var(--radix-select-trigger-width)]",
          )}
          position="popper"
          sideOffset={4}
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

function SelectItem({ value, children }: { value: string; children?: ComponentChildren }) {
  return (
    <SelectPrimitive.Item
      value={value}
      className={cn(
        "relative flex cursor-pointer select-none items-center rounded-md px-2 py-2 text-[var(--tc-text-sm)]",
        "outline-none data-[highlighted]:bg-[var(--tc-bg-muted)] data-[state=checked]:font-semibold",
      )}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
