/**
 * SDD 420 — opaque companion tab handles.
 * Chrome tab ids stay internal; agents only see ctab_* + documentToken.
 */

export type TabHandle = {
  tabId: string;
  chromeTabId: number;
  documentToken: string;
  url: string;
  title: string;
};

const byOpaque = new Map<string, TabHandle>();
const byChrome = new Map<number, string>();

function newOpaqueId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `ctab_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function tokenFor(tab: chrome.tabs.Tab): string {
  // Generation token: chrome id + url (navigation changes token → stale refs).
  return `d_${tab.id}_${encodeURIComponent(tab.url ?? "")}`;
}

/** Ensure a handle exists for a chrome tab; refresh documentToken on url change. */
export function ensureHandle(tab: chrome.tabs.Tab): TabHandle | undefined {
  if (tab.id == null) return undefined;
  const existingOpaque = byChrome.get(tab.id);
  const nextToken = tokenFor(tab);
  if (existingOpaque) {
    const h = byOpaque.get(existingOpaque);
    if (h) {
      h.url = tab.url ?? h.url;
      h.title = tab.title ?? h.title;
      if (h.documentToken !== nextToken) {
        h.documentToken = nextToken;
      }
      return h;
    }
  }
  const tabId = newOpaqueId();
  const handle: TabHandle = {
    tabId,
    chromeTabId: tab.id,
    documentToken: nextToken,
    url: tab.url ?? "",
    title: tab.title ?? "",
  };
  byOpaque.set(tabId, handle);
  byChrome.set(tab.id, tabId);
  return handle;
}

export function resolveHandle(
  tabId: string,
  expectedDocumentToken?: string,
):
  | { ok: true; handle: TabHandle }
  | { ok: false; code: "stale_tab" | "no_tab"; message: string } {
  const h = byOpaque.get(tabId.trim());
  if (!h) {
    return { ok: false, code: "no_tab", message: `Unknown tabId '${tabId}'. Call user_browser_tabs_list.` };
  }
  if (expectedDocumentToken && expectedDocumentToken !== h.documentToken) {
    return {
      ok: false,
      code: "stale_tab",
      message: "Document token mismatch — page navigated or snapshot is stale. Re-list/snapshot.",
    };
  }
  return { ok: true, handle: h };
}

export function dropChromeTab(chromeTabId: number): void {
  const opaque = byChrome.get(chromeTabId);
  if (!opaque) return;
  byChrome.delete(chromeTabId);
  byOpaque.delete(opaque);
}

export function clearAllHandles(): void {
  byOpaque.clear();
  byChrome.clear();
}

export async function listHandles(): Promise<
  Array<{ tabId: string; title: string; url: string; active: boolean; documentToken: string }>
> {
  const tabs = await chrome.tabs.query({});
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeId = active[0]?.id;
  const out: Array<{ tabId: string; title: string; url: string; active: boolean; documentToken: string }> = [];
  // Drop handles for closed tabs
  const live = new Set(tabs.map((t) => t.id).filter((id): id is number => id != null));
  for (const [cid] of byChrome) {
    if (!live.has(cid)) dropChromeTab(cid);
  }
  for (const t of tabs) {
    if (t.id == null) continue;
    // Skip chrome:// and similar for agent targeting list (still allow if already open)
    const h = ensureHandle(t);
    if (!h) continue;
    out.push({
      tabId: h.tabId,
      title: h.title || t.title || "",
      url: h.url || t.url || "",
      active: t.id === activeId,
      documentToken: h.documentToken,
    });
  }
  return out;
}
