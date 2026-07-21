/**
 * Content-script entry — DOM read + act (SDD 414).
 * Injected on demand via chrome.scripting (activeTab / host permissions).
 *
 * Never captures cookies; refuses password field fill/type.
 */

import { runPageAction, type PageActRequest } from "./actions.js";
import { installConsoleHook, readConsoleEntries } from "./consoleHook.js";

const MSG_SNAPSHOT = "tachyon.tab.snapshot";
const GUARD = "__tachyonCompanionContentV1";

const MAX_NODES = 400;
const MAX_DEPTH = 12;
const MAX_TEXT = 120;
const MAX_OUTLINE_CHARS = 24_000;
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "SVG",
  "PATH",
  "META",
  "LINK",
  "HEAD",
]);

export type DomOutlineNode = {
  tag: string;
  id?: string;
  role?: string;
  name?: string;
  href?: string;
  type?: string;
  text?: string;
  children?: DomOutlineNode[];
};

export type TabRefEntry = {
  ref: string;
  selector?: string;
  tag?: string;
  role?: string;
  name?: string;
};

export type TabSnapshotOk = {
  ok: true;
  url: string;
  title: string;
  capturedAt: string;
  selection?: string;
  /** Human/agent-readable indented outline (includes @e refs). */
  outline: string;
  /** Structured tree (capped). */
  tree: DomOutlineNode;
  /** Stable element refs for this document generation (SDD 420). */
  refs: TabRefEntry[];
  stats: { nodes: number; truncated: boolean; outlineChars: number };
};

export type TabSnapshotErr = {
  ok: false;
  code: "restricted" | "no_document" | "unknown";
  message: string;
};

export type TabSnapshotResult = TabSnapshotOk | TabSnapshotErr;

type WalkState = { nodes: number; truncated: boolean };

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
}

function visibleText(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.type === "password") return "[redacted]";
    return clip(el.value || el.placeholder || "", MAX_TEXT);
  }
  if (el instanceof HTMLSelectElement) {
    return clip(el.selectedOptions[0]?.text ?? el.value ?? "", MAX_TEXT);
  }
  // Prefer accessible name bits without dumping full textContent of large containers.
  const aria = el.getAttribute("aria-label");
  if (aria) return clip(aria, MAX_TEXT);
  if (el instanceof HTMLElement && el.title) return clip(el.title, MAX_TEXT);
  // Leaf-ish: short text only
  const kids = el.childNodes;
  let text = "";
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n?.nodeType === Node.TEXT_NODE) text += n.textContent ?? "";
  }
  return clip(text, MAX_TEXT);
}

function interesting(el: Element): boolean {
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) return false;
  if (tag === "INPUT" || tag === "BUTTON" || tag === "A" || tag === "TEXTAREA" || tag === "SELECT" || tag === "LABEL") {
    return true;
  }
  if (el.id || el.getAttribute("role") || el.getAttribute("aria-label") || el.getAttribute("name")) return true;
  if (tag === "H1" || tag === "H2" || tag === "H3" || tag === "H4" || tag === "MAIN" || tag === "NAV" || tag === "FORM") {
    return true;
  }
  // Keep structural containers that have children
  return el.children.length > 0;
}

function walk(el: Element, depth: number, state: WalkState): DomOutlineNode | null {
  if (state.nodes >= MAX_NODES) {
    state.truncated = true;
    return null;
  }
  if (depth > MAX_DEPTH) {
    state.truncated = true;
    return null;
  }
  if (SKIP_TAGS.has(el.tagName)) return null;
  if (!interesting(el) && el !== document.body && el !== document.documentElement) {
    // Still walk children of non-interesting wrappers so we don't drop nested controls.
    const kids: DomOutlineNode[] = [];
    for (const child of Array.from(el.children)) {
      const n = walk(child, depth + 1, state);
      if (n) kids.push(n);
      if (state.nodes >= MAX_NODES) break;
    }
    if (kids.length === 1) return kids[0]!;
    if (kids.length === 0) return null;
    return { tag: el.tagName.toLowerCase(), children: kids };
  }

  state.nodes += 1;
  const node: DomOutlineNode = { tag: el.tagName.toLowerCase() };
  if (el.id) node.id = clip(el.id, 64);
  const role = el.getAttribute("role");
  if (role) node.role = clip(role, 32);
  if (el instanceof HTMLAnchorElement && el.href) {
    try {
      node.href = clip(el.href, 200);
    } catch {
      /* ignore */
    }
  }
  if (el instanceof HTMLInputElement) {
    node.type = el.type || "text";
    if (el.name) node.name = clip(el.name, 64);
  } else {
    const name = el.getAttribute("name") || el.getAttribute("data-testid") || el.getAttribute("aria-label");
    if (name) node.name = clip(name, 80);
  }
  const text = visibleText(el);
  if (text) node.text = text;

  const children: DomOutlineNode[] = [];
  for (const child of Array.from(el.children)) {
    if (state.nodes >= MAX_NODES) {
      state.truncated = true;
      break;
    }
    const n = walk(child, depth + 1, state);
    if (n) children.push(n);
  }
  if (children.length) node.children = children;
  return node;
}

function formatOutline(node: DomOutlineNode, indent = 0): string {
  const pad = "  ".repeat(indent);
  const bits: string[] = [node.tag];
  if (node.id) bits.push(`#${node.id}`);
  if (node.role) bits.push(`[@role=${node.role}]`);
  if (node.type) bits.push(`[type=${node.type}]`);
  if (node.name) bits.push(`[name=${JSON.stringify(node.name)}]`);
  if (node.href) bits.push(`href=${JSON.stringify(node.href)}`);
  if (node.text) bits.push(`"${node.text}"`);
  let line = pad + bits.join(" ");
  if (node.children) {
    for (const c of node.children) {
      line += "\n" + formatOutline(c, indent + 1);
    }
  }
  return line;
}

function cssPath(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1 && parts.length < 6) {
    let part = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(cur) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(part);
    cur = parent;
    if (cur?.tagName === "BODY" || cur?.tagName === "HTML") break;
  }
  return parts.join(" > ");
}

/** Interactive leaves get stable @eN refs for this snapshot generation. */
function collectRefs(root: Element): TabRefEntry[] {
  const refs: TabRefEntry[] = [];
  const nodes = root.querySelectorAll(
    "a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[contenteditable=true],[data-testid]",
  );
  let n = 0;
  // Clear prior generation markers
  for (const el of Array.from(root.querySelectorAll("[data-tc-ref]"))) {
    el.removeAttribute("data-tc-ref");
  }
  for (const el of Array.from(nodes)) {
    if (n >= 200) break;
    if (el instanceof HTMLInputElement && el.type === "password") continue;
    n += 1;
    const ref = `@e${n}`;
    el.setAttribute("data-tc-ref", ref);
    const entry: TabRefEntry = { ref, tag: el.tagName.toLowerCase(), selector: cssPath(el) };
    const role = el.getAttribute("role");
    if (role) entry.role = clip(role, 32);
    const name =
      el.getAttribute("aria-label") ||
      el.getAttribute("name") ||
      el.getAttribute("data-testid") ||
      (el instanceof HTMLElement ? el.innerText?.slice(0, 40) : undefined);
    if (name) entry.name = clip(name, 80);
    refs.push(entry);
  }
  return refs;
}

function formatOutlineWithRefs(node: DomOutlineNode, indent = 0, refBySelector?: Map<string, string>): string {
  // Keep simple formatOutline for tree; refs are listed separately + in outline header.
  return formatOutline(node, indent);
}

function buildSnapshot(): TabSnapshotResult {
  try {
    if (!document?.documentElement) {
      return { ok: false, code: "no_document", message: "No document available." };
    }
    const refs = collectRefs(document.documentElement);
    const state: WalkState = { nodes: 0, truncated: false };
    const root = walk(document.documentElement, 0, state) ?? { tag: "html" };
    let outline = formatOutlineWithRefs(root);
    if (refs.length) {
      const refLines = refs
        .slice(0, 80)
        .map((r) => `${r.ref} ${r.tag ?? ""}${r.name ? ` "${r.name}"` : ""}${r.selector ? ` ${r.selector}` : ""}`)
        .join("\n");
      outline = `## refs\n${refLines}\n## tree\n${outline}`;
    }
    if (outline.length > MAX_OUTLINE_CHARS) {
      outline = outline.slice(0, MAX_OUTLINE_CHARS - 1) + "…";
      state.truncated = true;
    }
    const selection = window.getSelection()?.toString();
    return {
      ok: true,
      url: location.href,
      title: document.title || "",
      capturedAt: new Date().toISOString(),
      selection: selection && selection.trim() ? clip(selection, 2000) : undefined,
      outline,
      tree: root,
      refs,
      stats: {
        nodes: state.nodes,
        truncated: state.truncated,
        outlineChars: outline.length,
      },
    };
  } catch (e) {
    return {
      ok: false,
      code: "unknown",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

const MSG_ACT = "tachyon.tab.act";
const MSG_CONSOLE = "tachyon.tab.console";

// Idempotent inject: one listener per page.
const g = globalThis as unknown as Record<string, unknown>;
if (!g[GUARD]) {
  g[GUARD] = true;
  installConsoleHook();
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MSG_SNAPSHOT) {
      sendResponse(buildSnapshot());
      return true;
    }
    if (message?.type === MSG_ACT) {
      sendResponse(runPageAction(message.action as PageActRequest));
      return true;
    }
    if (message?.type === MSG_CONSOLE) {
      const limit = typeof message.limit === "number" ? message.limit : 30;
      sendResponse({ ok: true, entries: readConsoleEntries(limit) });
      return true;
    }
    return;
  });
}

export { MSG_SNAPSHOT, MSG_ACT, MSG_CONSOLE };
