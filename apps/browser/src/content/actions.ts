/**
 * Content-script page actions — click / type / fill (t-fbe280).
 * Isolated world only; no MAIN/CDP.
 *
 * Contenteditable / rich SPA composers (React controlled editors, Lexical,
 * ProseMirror, Draft, etc.) are a product surface: they ignore raw
 * textContent/append. Actuation must insert text like a user edit
 * (insertText / InputEvent) so framework state updates.
 */

export type PageActRequest =
  | { kind: "click"; selector: string }
  | { kind: "type"; selector: string; text: string; submit?: boolean }
  | { kind: "fill"; selector: string; value: string };

export type PageActResult =
  | { ok: true; kind: "click" | "type" | "fill"; selector: string; detail?: string }
  | { ok: false; code: "not_found" | "denied" | "unknown"; message: string };

const MAX_SELECTOR = 500;
const MAX_TEXT = 4000;

function resolveOne(selector: string): { el?: Element; error?: PageActResult } {
  const sel = selector.trim();
  if (!sel || sel.length > MAX_SELECTOR) {
    return {
      error: { ok: false, code: "unknown", message: "Invalid or empty selector." },
    };
  }
  let el: Element | null;
  try {
    el = document.querySelector(sel);
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

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Place the caret / selection inside a contenteditable for replace (fill) or
 * append (type).
 */
function selectContentEditable(el: HTMLElement, mode: "replace" | "append"): void {
  const selection = window.getSelection();
  if (!selection) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    if (mode === "append") range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // Some hosts reject selectNodeContents; continue with insert attempts.
  }
}

/**
 * User-like text insertion into contenteditable / rich composers.
 * Prefer execCommand('insertText') (fires beforeinput/input that SPAs listen for),
 * then InputEvent + DOM write, then plain DOM + synthetic events.
 */
function setContentEditableText(el: HTMLElement, text: string, mode: "replace" | "append"): string {
  el.focus();
  selectContentEditable(el, mode);

  // 1) insertText — replaces current selection (fill) or inserts at caret (type).
  try {
    if (document.execCommand("insertText", false, text)) {
      return mode === "replace" ? "contenteditable insertText replace" : "contenteditable insertText";
    }
  } catch {
    // continue
  }

  // 2) beforeinput/input with insertText — frameworks that listen without execCommand.
  const inputType = mode === "replace" ? "insertReplacementText" : "insertText";
  try {
    const before = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType,
      data: text,
    });
    const allowed = el.dispatchEvent(before);
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
      return mode === "replace" ? "contenteditable InputEvent replace" : "contenteditable InputEvent";
    }
  } catch {
    // InputEvent constructor may throw in very old environments — fall through.
  }

  // 3) Last resort: DOM write + generic input/change (plain contenteditable only).
  if (mode === "replace") el.textContent = text;
  else el.append(document.createTextNode(text));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return mode === "replace" ? "contenteditable textContent fallback" : "contenteditable append fallback";
}

export function runPageAction(req: PageActRequest): PageActResult {
  try {
    const { el, error } = resolveOne(req.selector);
    if (error) return error;
    if (!el) return { ok: false, code: "not_found", message: "Element missing." };

    if (req.kind === "click") {
      if (el instanceof HTMLElement) {
        el.focus();
        el.click();
      } else {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
      return { ok: true, kind: "click", selector: req.selector, detail: `clicked <${el.tagName.toLowerCase()}>` };
    }

    if (req.kind === "fill") {
      if (isPassword(el)) {
        return { ok: false, code: "denied", message: "Refusing to fill password fields." };
      }
      const value = req.value.slice(0, MAX_TEXT);
      if (el instanceof HTMLSelectElement) {
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, kind: "fill", selector: req.selector, detail: "select value set" };
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        setNativeValue(el, value);
        return { ok: true, kind: "fill", selector: req.selector, detail: "value set" };
      }
      if (el instanceof HTMLElement && el.isContentEditable) {
        const detail = setContentEditableText(el, value, "replace");
        return { ok: true, kind: "fill", selector: req.selector, detail };
      }
      return {
        ok: false,
        code: "unknown",
        message: `Element <${el.tagName.toLowerCase()}> is not fillable.`,
      };
    }

    // type
    if (isPassword(el)) {
      return { ok: false, code: "denied", message: "Refusing to type into password fields." };
    }
    const text = req.text.slice(0, MAX_TEXT);
    if (el instanceof HTMLElement) el.focus();

    let typeDetail = "typed";
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const next = (el.value || "") + text;
      setNativeValue(el, next.slice(0, MAX_TEXT));
      typeDetail = "typed";
    } else if (el instanceof HTMLElement && el.isContentEditable) {
      typeDetail = setContentEditableText(el, text, "append");
    } else {
      return {
        ok: false,
        code: "unknown",
        message: `Element <${el.tagName.toLowerCase()}> is not typeable.`,
      };
    }

    if (req.submit && el instanceof HTMLElement) {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }),
      );
      el.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }),
      );
      const form = el.closest("form");
      if (form instanceof HTMLFormElement) {
        // Prefer requestSubmit when available (fires validation).
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
    };
  } catch (e) {
    return {
      ok: false,
      code: "unknown",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
