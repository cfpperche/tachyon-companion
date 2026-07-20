import { cn } from "../cn.js";
import { Badge, type BadgeTone } from "./Badge.js";

export interface AgentRowProps {
  name: string;
  attention: string;
  composerOccupied?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  className?: string;
}

function toneForAttention(attention: string): BadgeTone {
  const a = attention.toLowerCase();
  if (a === "idle") return "success";
  if (a === "working") return "working";
  if (a === "needs-input") return "warning";
  if (a === "throttled") return "warning";
  if (a.includes("error") || a === "dead") return "danger";
  return "neutral";
}

export function AgentRow({
  name,
  attention,
  composerOccupied,
  selected,
  onSelect,
  className,
}: AgentRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-[var(--tc-radius-sm)]",
        "border border-[var(--tc-border)] bg-[var(--tc-bg-muted)] px-2.5 py-2 text-left",
        "hover:brightness-105 focus-visible:outline-none focus-visible:shadow-[var(--tc-focus)]",
        selected && "border-[var(--tc-accent)] ring-1 ring-[var(--tc-accent)]",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="truncate text-[var(--tc-text-sm)] font-semibold text-[var(--tc-text)]">{name}</div>
        {composerOccupied ? (
          <div className="text-[10px] text-[var(--tc-text-muted)]">composer occupied</div>
        ) : null}
      </div>
      <Badge tone={toneForAttention(attention)} dot>
        {attention}
      </Badge>
    </button>
  );
}
