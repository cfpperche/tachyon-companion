/**
 * Ring buffer of recent webRequest events for agent user_browser_network.
 * No request bodies, cookies, or Authorization headers — URL/method/status only.
 */

export type NetworkEntry = {
  tabId: number;
  url: string;
  method: string;
  statusCode?: number;
  type?: string;
  error?: string;
  at: string;
};

const MAX = 200;
const buffer: NetworkEntry[] = [];
let installed = false;

export function installNetworkLog(): void {
  if (installed) return;
  installed = true;
  try {
    chrome.webRequest.onCompleted.addListener(
      (details) => {
        if (details.tabId < 0) return;
        push({
          tabId: details.tabId,
          url: redactUrl(details.url),
          method: details.method,
          statusCode: details.statusCode,
          type: details.type,
          at: new Date().toISOString(),
        });
      },
      { urls: ["<all_urls>"] },
    );
    chrome.webRequest.onErrorOccurred.addListener(
      (details) => {
        if (details.tabId < 0) return;
        push({
          tabId: details.tabId,
          url: redactUrl(details.url),
          method: details.method,
          type: details.type,
          error: details.error,
          at: new Date().toISOString(),
        });
      },
      { urls: ["<all_urls>"] },
    );
  } catch (e) {
    console.warn("network log install failed", e);
  }
}

function push(e: NetworkEntry): void {
  buffer.push(e);
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
}

/** Strip query tokens that look like secrets. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const keys: string[] = [];
    u.searchParams.forEach((_v, k) => {
      keys.push(k);
    });
    for (const key of keys) {
      if (/token|secret|password|auth|key|session|cookie/i.test(key)) {
        u.searchParams.set(key, "[redacted]");
      }
    }
    return u.toString();
  } catch {
    return url.slice(0, 500);
  }
}

export function listNetworkForTab(
  chromeTabId: number,
  opts?: { limit?: number; urlContains?: string },
): NetworkEntry[] {
  const limit = Math.min(opts?.limit ?? 30, 100);
  const needle = opts?.urlContains?.toLowerCase();
  const rows = buffer.filter((e) => e.tabId === chromeTabId);
  const filtered = needle ? rows.filter((e) => e.url.toLowerCase().includes(needle)) : rows;
  return filtered.slice(-limit);
}
