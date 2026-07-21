/**
 * Content-script page actions — click / type / fill (t-fbe280).
 * Isolated world only; no MAIN/CDP.
 *
 * Contenteditable / rich SPA composers (React, Lexical, ProseMirror, Draft…)
 * are a product surface: raw textContent/append is not enough.
 *
 * Contract:
 *  - Prefer user-like insertion (focus, selection, insertText, paste, InputEvent).
 *  - Resolve wrappers → leaf editable when the selector hits a container.
 *  - Honesty: ok:true only when the visible value/text actually contains what we
 *    wrote. execCommand returning true without UI change → ok:false not_applied.
 */

export type PageActRequest =
  | { kind: "click"; selector: string }
  | { kind: "type"; selector: string; text: string; submit?: boolean }
  | { kind: "fill"; selector: string; value: string };

export type PageActResult =
  | {
      ok: true;
      kind: "click" | "type" | "fill";
      selector: string;
      detail?: string;
      /** Always true on success — text was observed in the control after the action. */
      verified: true;
      visibleText?: string;
    }
  | {
      ok: false;
      code: "not_found" | "denied" | "not_applied" | "unknown";
      message: string;
      detail?: string;
      visibleText?: string;
    };

const MAX_SELECTOR = 500;
const MAX_TEXT = 4000;

/** Deep query: light DOM + open shadow roots (breadth-first). */
function deepQuery(selector: string, root: ParentNode = document): Element | null {
  try {
    const direct = root.querySelector(selector);
    if (direct) return direct;
  } catch {
    return null;
  }
  const walk = (node: ParentNode): Element | null => {
    const els = node.querySelectorAll?.("*") ?? [];
    for (const el of Array.from(els)) {
      const sr = (el as Element).shadowRoot;
      if (sr) {
        try {
          const hit = sr.querySelector(selector);
          if (hit) return hit;
        } catch {
          /* invalid in this root */
        }
        const deeper = walk(sr);
        if (deeper) return deeper;
      }
    }
    return null;
  };
  return walk(root);
}

function resolveOne(selector: string): { el?: Element; error?: PageActResult } {
  const sel = selector.trim();
  if (!sel || sel.length > MAX_SELECTOR) {
    return {
      error: { ok: false, code: "unknown", message: "Invalid or empty selector." },
    };
  }
  // SDD 420: prefer stable @eN refs stamped by the last snapshot (incl. open shadow).
  if (/^@e\d+$/i.test(sel)) {
    const byRef = deepQuery(`[data-tc-ref="${sel}"]`);
    if (!byRef) {
      return {
        error: {
          ok: false,
          code: "not_found",
          message: `Stale or unknown ref ${sel}. Take a fresh snapshot on this tab.`,
        },
      };
    }
    return { el: byRef };
  }
  let el: Element | null;
  try {
    el = deepQuery(sel);
  } catch {
    return {
      error: { ok: false, code: "unknown", message: `Invalid CSS selector: ${sel}` },
    };
  }
  if (!el) {
    return {
      error: { ok: false, code: "not_found", message: `No element matches selector: ${sel}` },
    };
  }
  return { el };
}

function isPassword(el: Element): boolean {
  return el instanceof HTMLInputElement && el.type === "password";
}

/** Normalize for contains checks (ZWSP / NBSP common in rich editors). */
function normText(s: string): string {
  return s
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readVisibleText(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value ?? "";
  }
  if (el instanceof HTMLSelectElement) {
    return el.value ?? "";
  }
  if (el instanceof HTMLElement) {
    return el.innerText || el.textContent || "";
  }
  return el.textContent || "";
}

function textLanded(mode: "replace" | "append", expected: string, after: string, before: string): boolean {
  const e = normText(expected);
  if (!e) return true;
  const a = normText(after);
  if (mode === "replace") {
    return a === e || a.includes(e);
  }
  // append: must include the new text; prefer also growing vs before when before was non-empty
  if (!a.includes(e)) return false;
  const b = normText(before);
  if (!b) return true;
  // If before already contained expected (re-run), still ok.
  if (b.includes(e)) return true;
  return a.length >= b.length;
}

/**
 * If the selector hit a wrapper (common on Draft/Lexical roots), prefer the
 * leaf contenteditable / textbox / form control inside it.
 */
function resolveEditableTarget(el: Element): HTMLElement | null {
  if (isPassword(el)) return null;

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return el;
  }

  if (el instanceof HTMLElement && el.isContentEditable) {
    const nested = Array.from(
      el.querySelectorAll<HTMLElement>('[contenteditable="true"], [contenteditable=""]'),
    );
    let leaf: HTMLElement | null = null;
    for (const n of nested) {
      if (!n.isContentEditable) continue;
      // Prefer deepest leaf (no contenteditable descendants).
      if (!n.querySelector('[contenteditable="true"], [contenteditable=""]')) {
        leaf = n;
      }
    }
    if (leaf) return leaf;
    return el;
  }

  // Container: look for a usable control inside (first match in tree order).
  if (el instanceof HTMLElement) {
    const input = el.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([type="password"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
    );
    if (input) {
      if (input instanceof HTMLInputElement && input.type === "password") return null;
      if (input.isContentEditable || input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement) {
        // Recurse once for nested contenteditable roots.
        return resolveEditableTarget(input) ?? input;
      }
      if (input.getAttribute("role") === "textbox") {
        const inner = input.querySelector<HTMLElement>('[contenteditable="true"], [contenteditable=""]');
        if (inner?.isContentEditable) return resolveEditableTarget(inner) ?? inner;
        if (input.isContentEditable) return input;
      }
    }
  }

  return null;
}

function focusLikeUser(el: HTMLElement): void {
  try {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    /* ignore */
  }
  try {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  } catch {
    /* ignore */
  }
  try {
    el.focus({ preventScroll: true });
  } catch {
    try {
      el.focus();
    } catch {
      /* ignore */
    }
  }
  try {
    el.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  } catch {
    /* ignore */
  }
}

function selectAllOrEnd(el: HTMLElement, mode: "replace" | "append"): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      if (mode === "replace") el.select();
      else el.setSelectionRange(el.value.length, el.value.length);
    } catch {
      /* some input types reject select */
    }
    return;
  }
  const selection = window.getSelection();
  if (!selection) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    if (mode === "append") range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    /* ignore */
  }
}

function tryExecInsertText(text: string): boolean {
  try {
    return document.execCommand("insertText", false, text);
  } catch {
    return false;
  }
}

function tryExecSelectAll(): void {
  try {
    document.execCommand("selectAll", false);
  } catch {
    /* ignore */
  }
}

/** Clipboard paste event — many rich editors only accept insertFromPaste. */
function tryPaste(el: HTMLElement, text: string): string | null {
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const paste = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    } as ClipboardEventInit);
    el.dispatchEvent(paste);
    return "paste event";
  } catch {
    // Fallback: beforeinput insertFromPaste (no real clipboard).
    try {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: "insertFromPaste",
          data: text,
        }),
      );
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertFromPaste",
          data: text,
        }),
      );
      return "insertFromPaste InputEvent";
    } catch {
      return null;
    }
  }
}

function clearReactValueTracker(el: HTMLInputElement | HTMLTextAreaElement): void {
  // React 16–18 controlled-input tracker lives on the DOM node (shared across worlds).
  const tracker = (el as unknown as { _valueTracker?: { setValue: (v: string) => void } })._valueTracker;
  if (tracker && typeof tracker.setValue === "function") {
    try {
      tracker.setValue(el.value);
    } catch {
      /* ignore */
    }
  }
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): string {
  focusLikeUser(el);
  clearReactValueTracker(el);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  try {
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: value,
        inputType: "insertFromPaste",
      }),
    );
  } catch {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "native value + input";
}

/**
 * Apply text into a contenteditable leaf. Tries several user-like strategies
 * until verification passes (or all fail).
 */
function applyContentEditable(
  el: HTMLElement,
  text: string,
  mode: "replace" | "append",
): { method: string; verified: boolean; visible: string; before: string } {
  const before = readVisibleText(el);

  const strategies: Array<() => string> = [
    () => {
      focusLikeUser(el);
      selectAllOrEnd(el, mode);
      if (mode === "replace") tryExecSelectAll();
      const ok = tryExecInsertText(text);
      return ok ? (mode === "replace" ? "contenteditable insertText replace" : "contenteditable insertText") : "insertText returned false";
    },
    () => {
      focusLikeUser(el);
      selectAllOrEnd(el, mode);
      if (mode === "replace") {
        try {
          document.execCommand("delete", false);
        } catch {
          /* ignore */
        }
      }
      const label = tryPaste(el, text);
      return label ?? "paste unavailable";
    },
    () => {
      focusLikeUser(el);
      selectAllOrEnd(el, mode);
      const inputType = mode === "replace" ? "insertReplacementText" : "insertText";
      try {
        const beforeEv = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType,
          data: text,
        });
        const allowed = el.dispatchEvent(beforeEv);
        if (allowed) {
          if (mode === "replace") el.textContent = text;
          else el.append(document.createTextNode(text));
          el.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              composed: true,
              inputType,
              data: text,
            }),
          );
        }
        return mode === "replace" ? "contenteditable InputEvent replace" : "contenteditable InputEvent";
      } catch {
        return "InputEvent unavailable";
      }
    },
    () => {
      // Per-character insertText — some Draft/Lexical builds only accept short inserts.
      focusLikeUser(el);
      selectAllOrEnd(el, mode);
      if (mode === "replace") {
        tryExecSelectAll();
        try {
          document.execCommand("delete", false);
        } catch {
          /* ignore */
        }
      }
      let n = 0;
      for (const ch of text) {
        if (tryExecInsertText(ch)) n++;
      }
      return `contenteditable per-char insertText (${n}/${text.length})`;
    },
    () => {
      focusLikeUser(el);
      if (mode === "replace") el.textContent = text;
      else el.append(document.createTextNode(text));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return mode === "replace" ? "contenteditable textContent fallback" : "contenteditable append fallback";
    },
  ];

  let lastMethod = "none";
  for (const s of strategies) {
    lastMethod = s();
    const visible = readVisibleText(el);
    if (textLanded(mode, text, visible, before)) {
      return { method: lastMethod, verified: true, visible, before };
    }
  }
  return { method: lastMethod, verified: false, visible: readVisibleText(el), before };
}

function applyNativeInput(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  mode: "replace" | "append",
): { method: string; verified: boolean; visible: string; before: string } {
  const before = el.value ?? "";
  const next = mode === "replace" ? text : (before + text).slice(0, MAX_TEXT);

  const strategies: Array<() => string> = [
    () => {
      focusLikeUser(el);
      selectAllOrEnd(el, mode);
      if (mode === "replace") {
        try {
          el.select();
        } catch {
          /* ignore */
        }
        if (tryExecInsertText(text)) return "native insertText";
      } else if (tryExecInsertText(text)) {
        return "native insertText append";
      }
      return "native insertText false";
    },
    () => setNativeValue(el, next),
    () => {
      focusLikeUser(el);
      selectAllOrEnd(el, mode);
      const label = tryPaste(el, mode === "replace" ? text : text);
      // Paste may not set value on plain inputs — ensure value if still wrong.
      if (!textLanded(mode, text, el.value, before)) {
        return setNativeValue(el, next);
      }
      return label ?? "native paste";
    },
  ];

  let lastMethod = "none";
  for (const s of strategies) {
    lastMethod = s();
    const visible = el.value ?? "";
    if (textLanded(mode, text, visible, before)) {
      return { method: lastMethod, verified: true, visible, before };
    }
  }
  return { method: lastMethod, verified: false, visible: el.value ?? "", before };
}

function notApplied(
  kind: "type" | "fill",
  selector: string,
  detail: string,
  visibleText: string,
  expected: string,
): PageActResult {
  return {
    ok: false,
    code: "not_applied",
    message:
      `${kind} reported strategies ran but the control did not show the expected text ` +
      `(expected to include ${JSON.stringify(normText(expected).slice(0, 80))}; ` +
      `visible ${JSON.stringify(normText(visibleText).slice(0, 80))}). ` +
      `This is a failed actuation, not a successful edit.`,
    detail,
    visibleText: visibleText.slice(0, 200),
  };
}

export function runPageAction(req: PageActRequest): PageActResult {
  try {
    const { el, error } = resolveOne(req.selector);
    if (error) return error;
    if (!el) return { ok: false, code: "not_found", message: "Element missing." };

    if (req.kind === "click") {
      if (el instanceof HTMLElement) {
        focusLikeUser(el);
        el.click();
      } else {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
      return {
        ok: true,
        kind: "click",
        selector: req.selector,
        detail: `clicked <${el.tagName.toLowerCase()}>`,
        verified: true,
      };
    }

    if (req.kind === "fill") {
      if (isPassword(el)) {
        return { ok: false, code: "denied", message: "Refusing to fill password fields." };
      }
      const value = req.value.slice(0, MAX_TEXT);
      const target = resolveEditableTarget(el);
      if (!target) {
        return {
          ok: false,
          code: "unknown",
          message: `Element <${el.tagName.toLowerCase()}> is not fillable (no editable leaf).`,
        };
      }

      if (target instanceof HTMLSelectElement) {
        target.value = value;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        const visible = target.value;
        if (!textLanded("replace", value, visible, "")) {
          return notApplied("fill", req.selector, "select value set", visible, value);
        }
        return {
          ok: true,
          kind: "fill",
          selector: req.selector,
          detail: "select value set",
          verified: true,
          visibleText: visible.slice(0, 200),
        };
      }

      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const r = applyNativeInput(target, value, "replace");
        if (!r.verified) return notApplied("fill", req.selector, r.method, r.visible, value);
        return {
          ok: true,
          kind: "fill",
          selector: req.selector,
          detail: r.method,
          verified: true,
          visibleText: r.visible.slice(0, 200),
        };
      }

      if (target.isContentEditable) {
        const r = applyContentEditable(target, value, "replace");
        if (!r.verified) return notApplied("fill", req.selector, r.method, r.visible, value);
        return {
          ok: true,
          kind: "fill",
          selector: req.selector,
          detail: r.method,
          verified: true,
          visibleText: r.visible.slice(0, 200),
        };
      }

      return {
        ok: false,
        code: "unknown",
        message: `Element <${target.tagName.toLowerCase()}> is not fillable.`,
      };
    }

    // type
    if (isPassword(el)) {
      return { ok: false, code: "denied", message: "Refusing to type into password fields." };
    }
    const text = req.text.slice(0, MAX_TEXT);
    const target = resolveEditableTarget(el);
    if (!target) {
      return {
        ok: false,
        code: "unknown",
        message: `Element <${el.tagName.toLowerCase()}> is not typeable (no editable leaf).`,
      };
    }

    let typeDetail = "typed";
    let visible = "";
    let verified = false;

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const r = applyNativeInput(target, text, "append");
      typeDetail = r.method;
      visible = r.visible;
      verified = r.verified;
    } else if (target.isContentEditable) {
      const r = applyContentEditable(target, text, "append");
      typeDetail = r.method;
      visible = r.visible;
      verified = r.verified;
    } else {
      return {
        ok: false,
        code: "unknown",
        message: `Element <${target.tagName.toLowerCase()}> is not typeable.`,
      };
    }

    if (!verified) {
      return notApplied("type", req.selector, typeDetail, visible, text);
    }

    if (req.submit) {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }),
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }),
      );
      const form = target.closest("form");
      if (form instanceof HTMLFormElement) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      }
      typeDetail = `${typeDetail} + submit`;
    }

    return {
      ok: true,
      kind: "type",
      selector: req.selector,
      detail: typeDetail,
      verified: true,
      visibleText: visible.slice(0, 200),
    };
  } catch (e) {
    return {
      ok: false,
      code: "unknown",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
