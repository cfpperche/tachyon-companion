/**
 * Host bridge: service worker ↔ content script (DOM read + act).
 * Uses activeTab/scripting + optional host permissions for agent-initiated inject.
 */

import type { TabSnapshotResult } from "./content/snapshot.js";
import type { PageActRequest, PageActResult } from "./content/actions.js";

const MSG_SNAPSHOT = "tachyon.tab.snapshot";
const MSG_ACT = "tachyon.tab.act";

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
