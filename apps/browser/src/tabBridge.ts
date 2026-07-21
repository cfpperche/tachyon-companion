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
      code: "no_tab" | "restricted" | "inject_failed" | "unknown" | "not_applied" | "not_found" | "denied";
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

async function tabByChromeId(chromeTabId: number): Promise<chrome.tabs.Tab | undefined> {
  try {
    return await chrome.tabs.get(chromeTabId);
  } catch {
    return undefined;
  }
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
 * Capture a capped DOM outline of a specific Chrome tab (or active if omitted — legacy).
 */
export async function captureActiveTabSnapshot(chromeTabId?: number): Promise<CaptureTabSnapshotResponse> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = chromeTabId != null ? await tabByChromeId(chromeTabId) : await activeTab();
  } catch (e) {
    return {
      ok: false,
      code: "unknown",
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!tab?.id) {
    return {
      ok: false,
      code: "no_tab",
      message: chromeTabId != null ? `Tab ${chromeTabId} not found (closed?).` : "No active tab found.",
    };
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

/** First-person screenshot of a tab (defaults to active). Supports element crop + limited full_page stitch. */
export async function captureActiveTabScreenshot(opts?: {
  format?: "jpeg" | "png";
  quality?: number;
  chromeTabId?: number;
  scope?: "viewport" | "full_page" | "element";
  ref?: string;
  selector?: string;
}): Promise<ScreenshotResponse> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = opts?.chromeTabId != null ? await tabByChromeId(opts.chromeTabId) : await activeTab();
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
  const scope = opts?.scope ?? "viewport";
  const chromeTabId = tab.id;

  try {
    // Focus target tab so captureVisibleTab hits the right surface.
    await chrome.tabs.update(chromeTabId, { active: true });
    await new Promise((r) => setTimeout(r, 80));

    if (scope === "element") {
      const sel = (opts?.ref?.trim() || opts?.selector?.trim() || "").trim();
      if (!sel) {
        return { ok: false, code: "unknown", message: "scope=element requires ref or selector", url: tab.url };
      }
      const [{ result: rect }] = await chrome.scripting.executeScript({
        target: { tabId: chromeTabId },
        func: (selector: string) => {
          const el =
            /^@e\d+$/i.test(selector)
              ? document.querySelector(`[data-tc-ref="${selector}"]`)
              : document.querySelector(selector);
          if (!(el instanceof Element)) return null;
          (el as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
          const r = el.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;
          return {
            x: Math.max(0, r.x * dpr),
            y: Math.max(0, r.y * dpr),
            w: Math.max(1, r.width * dpr),
            h: Math.max(1, r.height * dpr),
            vw: window.innerWidth * dpr,
            vh: window.innerHeight * dpr,
          };
        },
        args: [sel],
      });
      await new Promise((r) => setTimeout(r, 60));
      if (!rect) {
        return { ok: false, code: "unknown", message: `Element not found for screenshot: ${sel}`, url: tab.url };
      }
      const full = await captureVisible(tab.windowId, format, quality);
      if (!full.ok) return { ...full, url: tab.url };
      const cropped = await cropDataUrl(full.dataUrl, rect, format, quality);
      return {
        ok: true,
        url: tab.url ?? "",
        title: tab.title ?? "",
        capturedAt: new Date().toISOString(),
        dataUrl: cropped.dataUrl,
        byteLength: cropped.byteLength,
        mimeType: format === "png" ? "image/png" : "image/jpeg",
      };
    }

    if (scope === "full_page") {
      const stitched = await captureFullPage(chromeTabId, tab.windowId, format, quality, tab);
      return stitched;
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format,
      ...(format === "jpeg" ? { quality } : {}),
    });
    if (!dataUrl || typeof dataUrl !== "string") {
      return { ok: false, code: "unknown", message: "captureVisibleTab returned empty.", url: tab.url };
    }
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

async function captureVisible(
  windowId: number,
  format: "jpeg" | "png",
  quality: number,
): Promise<{ ok: true; dataUrl: string } | { ok: false; code: "unknown"; message: string }> {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format,
    ...(format === "jpeg" ? { quality } : {}),
  });
  if (!dataUrl) return { ok: false, code: "unknown", message: "captureVisibleTab empty" };
  return { ok: true, dataUrl };
}

async function cropDataUrl(
  dataUrl: string,
  rect: { x: number; y: number; w: number; h: number; vw: number; vh: number },
  format: "jpeg" | "png",
  quality: number,
): Promise<{ dataUrl: string; byteLength: number }> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const scaleX = bmp.width / rect.vw;
  const scaleY = bmp.height / rect.vh;
  const sx = Math.min(bmp.width - 1, Math.max(0, Math.floor(rect.x * scaleX)));
  const sy = Math.min(bmp.height - 1, Math.max(0, Math.floor(rect.y * scaleY)));
  const sw = Math.min(bmp.width - sx, Math.max(1, Math.floor(rect.w * scaleX)));
  const sh = Math.min(bmp.height - sy, Math.max(1, Math.floor(rect.h * scaleY)));
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d unavailable");
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  const out = await canvas.convertToBlob({
    type: format === "png" ? "image/png" : "image/jpeg",
    quality: quality / 100,
  });
  const ab = await out.arrayBuffer();
  const b64 = bytesToBase64(new Uint8Array(ab));
  const mime = format === "png" ? "image/png" : "image/jpeg";
  return { dataUrl: `data:${mime};base64,${b64}`, byteLength: ab.byteLength };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Stitch up to ~4 viewport tiles (cap height) — best-effort full page. */
async function captureFullPage(
  chromeTabId: number,
  windowId: number,
  format: "jpeg" | "png",
  quality: number,
  tab: chrome.tabs.Tab,
): Promise<ScreenshotResponse> {
  const [{ result: metrics }] = await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    func: () => ({
      scrollY: window.scrollY,
      innerH: window.innerHeight,
      scrollH: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      dpr: window.devicePixelRatio || 1,
    }),
  });
  if (!metrics) {
    return { ok: false, code: "unknown", message: "Could not measure page for full_page", url: tab.url };
  }
  const maxTiles = 4;
  const tiles: ImageBitmap[] = [];
  const step = metrics.innerH;
  const total = Math.min(metrics.scrollH, step * maxTiles);
  try {
    for (let y = 0; y < total; y += step) {
      await chrome.scripting.executeScript({
        target: { tabId: chromeTabId },
        func: (yy: number) => window.scrollTo(0, yy),
        args: [y],
      });
      await new Promise((r) => setTimeout(r, 120));
      const cap = await captureVisible(windowId, format, quality);
      if (!cap.ok) {
        return { ok: false, code: "unknown", message: cap.message, url: tab.url };
      }
      const res = await fetch(cap.dataUrl);
      tiles.push(await createImageBitmap(await res.blob()));
    }
    if (tiles.length === 0) {
      return { ok: false, code: "unknown", message: "No tiles captured", url: tab.url };
    }
    const w = tiles[0]!.width;
    const h = tiles.reduce((acc, t) => acc + t.height, 0);
    const canvas = new OffscreenCanvas(w, Math.min(h, w * 8));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d unavailable");
    let dy = 0;
    for (const t of tiles) {
      ctx.drawImage(t, 0, dy);
      dy += t.height;
      if (dy >= canvas.height) break;
    }
    const out = await canvas.convertToBlob({
      type: format === "png" ? "image/png" : "image/jpeg",
      quality: quality / 100,
    });
    const ab = await out.arrayBuffer();
    // restore scroll
    await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      func: (yy: number) => window.scrollTo(0, yy),
      args: [metrics.scrollY],
    });
    const b64 = bytesToBase64(new Uint8Array(ab));
    const mime = format === "png" ? "image/png" : "image/jpeg";
    return {
      ok: true,
      url: tab.url ?? "",
      title: tab.title ?? "",
      capturedAt: new Date().toISOString(),
      dataUrl: `data:${mime};base64,${b64}`,
      byteLength: ab.byteLength,
      mimeType: mime,
    };
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: chromeTabId },
        func: (yy: number) => window.scrollTo(0, yy),
        args: [metrics.scrollY],
      });
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      code: "unknown",
      message: e instanceof Error ? e.message : String(e),
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

/** Run click / type / fill on a specific Chrome tab (or active if omitted). */
export async function runActiveTabAction(
  action: PageActRequest,
  chromeTabId?: number,
): Promise<RunTabActionResponse> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = chromeTabId != null ? await tabByChromeId(chromeTabId) : await activeTab();
  } catch (e) {
    return {
      ok: false,
      code: "unknown",
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!tab?.id) {
    return {
      ok: false,
      code: "no_tab",
      message: chromeTabId != null ? `Tab ${chromeTabId} not found (closed?).` : "No active tab found.",
    };
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
