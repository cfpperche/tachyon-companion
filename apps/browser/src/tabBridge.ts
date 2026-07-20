/**
 * Host bridge: service worker ↔ content script (DOM read only).
 * Uses activeTab + scripting; injects snapshot.js on demand.
 */

import type { TabSnapshotResult } from "./content/snapshot.js";

const MSG_SNAPSHOT = "tachyon.tab.snapshot";

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

function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  if (RESTRICTED.test(url)) return true;
  if (url.startsWith("https://chrome.google.com/webstore")) return true;
  if (url.startsWith("https://chromewebstore.google.com")) return true;
  return false;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  // Prefer last-focused window (side panel is open) then current window.
  const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused[0]?.id != null) return focused[0];
  const cur = await chrome.tabs.query({ active: true, currentWindow: true });
  return cur[0];
}

/**
 * Capture a capped DOM outline of the user's active tab.
 * Call from a user gesture (button click) so activeTab grants access.
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

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/snapshot.js"],
    });
  } catch (e) {
    return {
      ok: false,
      code: "inject_failed",
      message:
        e instanceof Error
          ? e.message
          : "Could not inject content script. Click the page, then try again (activeTab).",
      url: tab.url,
    };
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
