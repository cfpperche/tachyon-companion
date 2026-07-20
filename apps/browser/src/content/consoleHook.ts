/**
 * Lightweight console capture for Companion (t-5c77bd).
 * Hooks console.* in the isolated world — enough for many pages;
 * MAIN-world eval can still be used for page-specific diagnostics.
 */

const GUARD = "__tachyonCompanionConsoleV1";
const MAX = 80;

export type ConsoleEntry = { level: string; text: string; at: string };

type ConsoleBag = {
  entries: ConsoleEntry[];
  push: (level: string, args: unknown[]) => void;
};

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ")
    .slice(0, 2000);
}

function ensureBag(): ConsoleBag {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g[GUARD]) return g[GUARD] as ConsoleBag;
  const entries: ConsoleEntry[] = [];
  const bag: ConsoleBag = {
    entries,
    push(level, args) {
      entries.push({
        level,
        text: formatArgs(args),
        at: new Date().toISOString(),
      });
      while (entries.length > MAX) entries.shift();
    },
  };
  g[GUARD] = bag;

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        bag.push(level, args);
      } catch {
        /* ignore */
      }
      original(...args);
    };
  }
  return bag;
}

export function installConsoleHook(): void {
  ensureBag();
}

export function readConsoleEntries(limit = 30): ConsoleEntry[] {
  const bag = ensureBag();
  const n = Math.max(1, Math.min(100, limit));
  return bag.entries.slice(-n);
}
