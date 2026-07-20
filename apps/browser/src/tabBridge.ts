/**
 * Host bridge: service worker ↔ content script (DOM read + act).
 * Uses activeTab/scripting + optional host permissions for agent-initiated inject.
 */

import type { TabSnapshotResult } from "./content/snapshot.js";
import type { PageActRequest, PageActResult } from "./content/actions.js";

const MSG_SNAPSHOT = "tachyon.tab.snapshot";
const MSG_ACT = "tachyon.tab.act";
const MSG_CONSOLE = "tachyon.tab.console";

const RESTRICTED =
  /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-search|chrome-devtools):/i;

export type CaptureTabSnapshotResponse =
  | TabSnapshotResult
  | {
      ok: false;
      code: "no_tab" | "restricted" | "inject_failed" | "unknown";
      message: string;
      url?: string;
    };

export type RunTabActionResponse =
  | (PageActResult & { url?: string })
  | {
      ok: false;
      code: "no_tab" | "restricted" | "inject_failed" | "unknown";
      message: string;
      url?: string;
    };

function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  if (RESTRICTED.test(url)) return true;
  if (url.startsWith("https://chrome.google.com/webstore")) return true;
  if (url.startsWith("https://chromewebstore.google.com")) return true;
  return false;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused[0]?.id != null) return focused[0];
  const cur = await chrome.tabs.query({ active: true, currentWindow: true });
  return cur[0];
}

async function ensureContentScript(tabId: number): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/snapshot.js"],
    });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message:
        e instanceof Error
          ? e.message
          : "Could not inject content script. Grant host access or click the page (activeTab).",
    };
  }
}

/**
 * Capture a capped DOM outline of the user's active tab.
 */
export async function captureActiveTabSnapshot(): Promise<CaptureTabSnapshotResponse> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await activeTab();
  } catch (e) {
    return {
      ok: false,
      code: "unknown",
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!tab?.id) {
    return { ok: false, code: "no_tab", message: "No active tab found." };
  }
  if (isRestrictedUrl(tab.url)) {
    return {
      ok: false,
      code: "restricted",
      message: "This page cannot be read (browser UI / store / restricted URL).",
      url: tab.url,
    };
  }

  const inj = await ensureContentScript(tab.id);
  if (!inj.ok) {
    return { ok: false, code: "inject_failed", message: inj.message, url: tab.url };
  }

  try {
    const result = (await chrome.tabs.sendMessage(tab.id, {
      type: MSG_SNAPSHOT,
    })) as TabSnapshotResult | undefined;
    if (!result) {
      return {
        ok: false,
        code: "unknown",
        message: "Content script returned no snapshot.",
        url: tab.url,
      };
    }
    return result;
  } catch (e) {
    return {
      ok: false,
      code: "unknown",
      message: e instanceof Error ? e.message : String(e),
      url: tab.url,
    };
  }
}

export type ScreenshotResponse =
  | {
      ok: true;
      url: string;
      title: string;
      capturedAt: string;
      dataUrl: string;
      byteLength: number;
      mimeType: string;
    }
  | {
      ok: false;
      code: "no_tab" | "restricted" | "inject_failed" | "unknown";
      message: string;
      url?: string;
    };

/** First-person screenshot of the active tab (what the human sees). */
export async function captureActiveTabScreenshot(opts?: {
  format?: "jpeg" | "png";
  quality?: number;
}): Promise<ScreenshotResponse> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await activeTab();
  } catch (e) {
    return { ok: false, code: "unknown", message: e instanceof Error ? e.message : String(e) };
  }
  if (!tab?.id) {
    return { ok: false, code: "no_tab", message: "No active tab found." };
  }
  if (isRestrictedUrl(tab.url)) {
    return {
      ok: false,
      code: "restricted",
      message: "This page cannot be captured (browser UI / store / restricted URL).",
      url: tab.url,
    };
  }

  const format = opts?.format === "png" ? "png" : "jpeg";
  const quality = Math.min(100, Math.max(10, opts?.quality ?? 70));

  try {
    // Prefer the tab's window so we capture the human's visible surface.
    const windowId = tab.windowId;
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format,
      ...(format === "jpeg" ? { quality } : {}),
    });
    if (!dataUrl || typeof dataUrl !== "string") {
      return { ok: false, code: "unknown", message: "captureVisibleTab returned empty.", url: tab.url };
    }
    // Approximate byte length of base64 payload (without data: prefix).
    const b64 = dataUrl.includes(",") ? dataUrl.split(",")[1]! : dataUrl;
    const byteLength = Math.floor((b64.length * 3) / 4);
    return {
      ok: true,
      url: tab.url ?? "",
      title: tab.title ?? "",
      capturedAt: new Date().toISOString(),
      dataUrl,
      byteLength,
      mimeType: format === "png" ? "image/png" : "image/jpeg",
    };
  } catch (e) {
    return {
      ok: false,
      code: "unknown",
      message:
        e instanceof Error
          ? e.message
          : "Screenshot failed. Ensure agent tab host access is granted and a normal http(s) tab is focused.",
      url: tab.url,
    };
  }
}

export type EvalResponse =
  | { ok: true; expression: string; result: string; url?: string }
  | {
      ok: false;
      code: "no_tab" | "restricted" | "inject_failed" | "unknown";
      message: string;
      url?: string;
    };

/** MAIN-world expression eval (capped string result). */
export async function evalActiveTab(expression: string): Promise<EvalResponse> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await activeTab();
  } catch (e) {
    return { ok: false, code: "unknown", message: e instanceof Error ? e.message : String(e) };
  }
  if (!tab?.id) {
    return { ok: false, code: "no_tab", message: "No active tab found." };
  }
  if (isRestrictedUrl(tab.url)) {
    return {
      ok: false,
      code: "restricted",
      message: "Cannot eval on this page.",
      url: tab.url,
    };
  }
  const expr = expression.trim().slice(0, 4000);
  if (!expr) {
    return { ok: false, code: "unknown", message: "Empty expression." };
  }

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: (source: string) => {
        try {
          const value = Function(`"use strict"; return (${source});`)();
          if (value === undefined) return "undefined";
          if (typeof value === "string") return value.slice(0, 8000);
          try {
            return JSON.stringify(value)?.slice(0, 8000) ?? String(value);
          } catch {
            return String(value).slice(0, 8000);
          }
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      args: [expr],
    });
    return {
      ok: true,
      expression: expr,
      result: typeof result === "string" ? result : String(result ?? ""),
      url: tab.url,
    };
  } catch (e) {
    return {
      ok: false,
      code: "inject_failed",
      message: e instanceof Error ? e.message : String(e),
      url: tab.url,
    };
  }
}

export type ConsoleResponse =
  | { ok: true; entries: Array<{ level: string; text: string; at?: string }>; url?: string }
  | {
      ok: false;
      code: "no_tab" | "restricted" | "inject_failed" | "unknown";
      message: string;
      url?: string;
    };

export async function readActiveTabConsole(limit = 30): Promise<ConsoleResponse> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await activeTab();
  } catch (e) {
    return { ok: false, code: "unknown", message: e instanceof Error ? e.message : String(e) };
  }
  if (!tab?.id) {
    return { ok: false, code: "no_tab", message: "No active tab found." };
  }
  if (isRestrictedUrl(tab.url)) {
    return { ok: false, code: "restricted", message: "Cannot read console on this page.", url: tab.url };
  }
  const inj = await ensureContentScript(tab.id);
  if (!inj.ok) {
    return { ok: false, code: "inject_failed", message: inj.message, url: tab.url };
  }
  try {
    const res = (await chrome.tabs.sendMessage(tab.id, {
      type: MSG_CONSOLE,
      limit,
    })) as { ok?: boolean; entries?: Array<{ level: string; text: string; at?: string }> };
    return { ok: true, entries: res?.entries ?? [], url: tab.url };
  } catch (e) {
    return {
      ok: false,
      code: "unknown",
      message: e instanceof Error ? e.message : String(e),
      url: tab.url,
    };
  }
}

/** Run click / type / fill on the active tab via content script. */
export async function runActiveTabAction(action: PageActRequest): Promise<RunTabActionResponse> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await activeTab();
  } catch (e) {
    return {
      ok: false,
      code: "unknown",
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!tab?.id) {
    return { ok: false, code: "no_tab", message: "No active tab found." };
  }
  if (isRestrictedUrl(tab.url)) {
    return {
      ok: false,
      code: "restricted",
      message: "This page cannot be controlled (browser UI / store / restricted URL).",
      url: tab.url,
    };
  }

  const inj = await ensureContentScript(tab.id);
  if (!inj.ok) {
    return { ok: false, code: "inject_failed", message: inj.message, url: tab.url };
  }

  try {
    const result = (await chrome.tabs.sendMessage(tab.id, {
      type: MSG_ACT,
      action,
    })) as PageActResult | undefined;
    if (!result) {
      return {
        ok: false,
        code: "unknown",
        message: "Content script returned no action result.",
        url: tab.url,
      };
    }
    return { ...result, url: tab.url };
  } catch (e) {
    return {
      ok: false,
      code: "unknown",
      message: e instanceof Error ? e.message : String(e),
      url: tab.url,
    };
  }
}
