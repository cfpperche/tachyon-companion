import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../cn.js";

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
}: {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        "relative h-5 w-9 shrink-0 cursor-pointer rounded-full border border-[var(--tc-border)]",
        "bg-[var(--tc-bg-muted)] transition-colors",
        "data-[state=checked]:bg-[var(--tc-accent)] data-[state=checked]:border-transparent",
        "focus-visible:outline-none focus-visible:shadow-[var(--tc-focus)]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "block h-4 w-4 translate-x-0.5 rounded-full bg-[var(--tc-bg-elevated)] shadow",
          "transition-transform data-[state=checked]:translate-x-[18px]",
        )}
      />
    </SwitchPrimitive.Root>
  );
}
