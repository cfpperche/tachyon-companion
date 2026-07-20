/**
 * Content-script page actions — click / type / fill (t-fbe280).
 * Isolated world only; no MAIN/CDP.
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
      if ((el as HTMLElement).isContentEditable) {
        (el as HTMLElement).focus();
        (el as HTMLElement).textContent = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true, kind: "fill", selector: req.selector, detail: "contenteditable set" };
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

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const next = (el.value || "") + text;
      setNativeValue(el, next.slice(0, MAX_TEXT));
    } else if ((el as HTMLElement).isContentEditable) {
      (el as HTMLElement).append(text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
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
    }

    return {
      ok: true,
      kind: "type",
      selector: req.selector,
      detail: req.submit ? "typed + submit" : "typed",
    };
  } catch (e) {
    return {
      ok: false,
      code: "unknown",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
