/**
 * Service worker — pairing + live state sync + send prompt + tab bridge (SDD 414).
 * Owns the engine SSE connection; side panel only reads local state.
 * Tab DOM read: host bridge → content script (t-88a17c).
 */

import { CompanionClient } from "@tachyon-companion/api-client";
import {
  COMPANION_PROTOCOL_VERSION,
  type CompanionAgentRow,
  type CompanionTabCommand,
  type CompanionTabResult,
  type ConnectionStatus,
} from "@tachyon-companion/protocol";
import {
  captureActiveTabScreenshot,
  captureActiveTabSnapshot,
  evalActiveTab,
  readActiveTabConsole,
  runActiveTabAction,
} from "./tabBridge.js";
import { readTrust } from "./trust.js";

const STORAGE_KEY = "tachyonCompanion.v1";
const LIVE_KEY = "tachyonCompanion.live.v1";

/** Origins the pair HTTP client needs (loopback engine). */
const LOOPBACK_ENGINE_ORIGINS = ["http://127.0.0.1/*", "http://localhost/*", "http://[::1]/*"] as const;

/**
 * Ensure MV3 host access for the engine Base URL before pair POST.
 * Declared host_permissions cover loopback; non-loopback uses optional permissions.
 * chrome.permissions.request is best from the side panel (user gesture); SW contains as fallback.
 */
async function ensureEngineHostPermission(baseUrl: string): Promise<void> {
  let originPattern: string;
  try {
    const u = new URL(baseUrl);
    originPattern = `${u.protocol}//${u.host}/*`;
  } catch {
    throw new Error(`Invalid Base URL: ${baseUrl}`);
  }
  const origins = Array.from(new Set([originPattern, ...LOOPBACK_ENGINE_ORIGINS]));
  try {
    const has = await chrome.permissions.contains({ origins });
    if (has) return;
    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      throw new Error(
        `Chrome blocked access to ${originPattern}. Reload the extension after update, or grant host access when prompted.`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Chrome blocked")) throw error;
    // contains/request can throw in restricted contexts — still attempt pair if host_permissions cover loopback
    let isLoopback = false;
    try {
      const host = new URL(baseUrl).hostname;
      isLoopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
    } catch {
      /* ignore */
    }
    if (!isLoopback) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}

interface StoredState {
  baseUrl?: string;
  sessionToken?: string;
  status: ConnectionStatus;
}

export interface LiveView {
  connection: ConnectionStatus & {
    baseUrl?: string;
    extensionVersion?: string;
  };
  agents: CompanionAgentRow[];
  seq: number;
  at?: string;
  stream: "idle" | "connecting" | "live" | "reconnecting" | "error";
  streamError?: string;
}

const defaultState = (): StoredState => ({
  status: { status: "disconnected", protocolVersion: COMPANION_PROTOCOL_VERSION },
});

const defaultLive = (): LiveView => ({
  connection: {
    status: "disconnected",
    protocolVersion: COMPANION_PROTOCOL_VERSION,
    extensionVersion: chrome.runtime.getManifest().version,
  },
  agents: [],
  seq: 0,
  stream: "idle",
});

async function readState(): Promise<StoredState> {
  const bag = await chrome.storage.local.get(STORAGE_KEY);
  const raw = bag[STORAGE_KEY] as StoredState | undefined;
  return raw ?? defaultState();
}

async function writeState(state: StoredState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function readLive(): Promise<LiveView> {
  const bag = await chrome.storage.local.get(LIVE_KEY);
  const raw = bag[LIVE_KEY] as LiveView | undefined;
  return raw ?? defaultLive();
}

async function writeLive(live: LiveView): Promise<void> {
  await chrome.storage.local.set({ [LIVE_KEY]: live });
  // Side panel listens on storage; also ping open ports for immediacy.
  try {
    await chrome.runtime.sendMessage({ type: "liveState", state: live });
  } catch {
    /* no receivers */
  }
}

function clientFrom(state: StoredState): CompanionClient {
  return new CompanionClient({
    baseUrl: state.baseUrl,
    sessionToken: state.sessionToken,
  });
}

function statusView(state: StoredState, status: ConnectionStatus) {
  return {
    ...status,
    baseUrl: state.baseUrl,
    protocolVersion: COMPANION_PROTOCOL_VERSION,
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

// ─── Live SSE (engine → SW → storage → UI) ───────────────────────────────────

let liveAbort: AbortController | undefined;
let liveLoopGeneration = 0;

function stopLiveStream(): void {
  liveLoopGeneration += 1;
  liveAbort?.abort();
  liveAbort = undefined;
}

async function startLiveStream(): Promise<void> {
  stopLiveStream();
  const gen = liveLoopGeneration;
  const state = await readState();
  if (!state.baseUrl || !state.sessionToken) {
    await writeLive(defaultLive());
    return;
  }

  let backoffMs = 500;
  const maxBackoff = 15_000;

  while (gen === liveLoopGeneration) {
    const current = await readState();
    if (!current.baseUrl || !current.sessionToken) {
      await writeLive(defaultLive());
      return;
    }

    const ac = new AbortController();
    liveAbort = ac;
    await writeLive({
      ...(await readLive()),
      connection: statusView(current, current.status),
      stream: backoffMs > 500 ? "reconnecting" : "connecting",
      streamError: undefined,
    });

    try {
      const client = clientFrom(current);
      for await (const ev of client.liveEvents(ac.signal)) {
        if (gen !== liveLoopGeneration) return;
        if (ev.type === "snapshot") {
          backoffMs = 500;
          const conn = statusView(current, ev.state.connection);
          await writeState({
            ...current,
            status: ev.state.connection,
          });
          await writeLive({
            connection: conn,
            agents: ev.state.agents,
            seq: ev.state.seq,
            at: ev.state.at,
            stream: "live",
          });
        } else if (ev.type === "session") {
          await writeLive({
            ...defaultLive(),
            connection: {
              status: "disconnected",
              protocolVersion: COMPANION_PROTOCOL_VERSION,
              extensionVersion: chrome.runtime.getManifest().version,
              baseUrl: current.baseUrl,
            },
            stream: "idle",
            streamError: ev.reason,
          });
          if (ev.reason === "unpaired" || ev.reason === "expired") {
            await writeState(defaultState());
            return;
          }
        } else if (ev.type === "tab.command") {
          // Agent tool user_browser_* — fulfill if trust allows (SDD 420 entry includes tab_open).
          void fulfillTabCommandEntry(client, ev.command).catch((err) => {
            console.error("tab.command fulfill failed", err);
          });
        } else if (ev.type === "approvals.changed") {
          // Persist a tick so the side panel can react via storage.onChanged
          // (sendMessage alone is easy to miss if the panel wasn't listening yet).
          await chrome.storage.local.set({
            "tachyonCompanion.approvals.tick": {
              at: Date.now(),
              id: ev.id,
              decision: ev.decision,
            },
          });
          try {
            await chrome.runtime.sendMessage({
              type: "approvalsChanged",
              id: ev.id,
              decision: ev.decision,
            });
          } catch {
            /* no side panel open */
          }
        }
        // heartbeat: no-op (keeps SW fetch alive)
      }
      // clean end → reconnect
    } catch (error) {
      if (ac.signal.aborted || gen !== liveLoopGeneration) return;
      const msg = error instanceof Error ? error.message : String(error);
      await writeLive({
        ...(await readLive()),
        stream: "error",
        streamError: msg,
      });
    }

    if (gen !== liveLoopGeneration) return;
    await sleep(backoffMs);
    backoffMs = Math.min(maxBackoff, Math.floor(backoffMs * 1.6));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Handle engine tab.command — trust-gated, tabId-scoped (SDD 420). */
async function fulfillTabCommand(client: CompanionClient, command: CompanionTabCommand): Promise<void> {
  const { listHandles, resolveHandle } = await import("./tabHandles.js");

  if (command.kind === "tabs_list") {
    const tabs = await listHandles();
    await client.postTabResult({
      ok: true,
      id: command.id,
      kind: "tabs_list",
      tabs,
    });
    return;
  }

  const trust = await readTrust();
  if (trust.agentTabRead !== "on") {
    await client.postTabResult({
      ok: false,
      id: command.id,
      code: "denied",
      message:
        "Agent tab access is off. Enable “Allow agent tab reads” in Companion Settings (host access for http/https).",
      tabId: "tabId" in command ? command.tabId : undefined,
    });
    return;
  }

  const target = resolveHandle(command.tabId, command.expectedDocumentToken);
  if (!target.ok) {
    await client.postTabResult({
      ok: false,
      id: command.id,
      code: target.code,
      message: target.message,
      tabId: command.tabId,
    });
    return;
  }
  const chromeTabId = target.handle.chromeTabId;
  const tabId = target.handle.tabId;
  const documentToken = target.handle.documentToken;

  if (command.kind === "snapshot") {
    const snap = await captureActiveTabSnapshot(chromeTabId);
    const { ensureHandle } = await import("./tabHandles.js");
    let docTok = documentToken;
    try {
      const t = await chrome.tabs.get(chromeTabId);
      const h = ensureHandle(t);
      if (h) docTok = h.documentToken;
    } catch {
      /* ignore */
    }
    const body: CompanionTabResult = snap.ok
      ? {
          ok: true,
          id: command.id,
          kind: "snapshot",
          tabId,
          documentToken: docTok,
          url: snap.url,
          title: snap.title,
          capturedAt: snap.capturedAt,
          selection: snap.selection,
          outline: snap.outline,
          refs: snap.refs,
          stats: snap.stats,
        }
      : {
          ok: false,
          id: command.id,
          code:
            snap.code === "restricted" ||
            snap.code === "no_tab" ||
            snap.code === "inject_failed" ||
            snap.code === "unknown"
              ? snap.code
              : "unknown",
          message: snap.message,
          tabId,
          url: snap.url,
        };
    await client.postTabResult(body);
    return;
  }

  if (command.kind === "screenshot") {
    const shot = await captureActiveTabScreenshot({
      format: command.format,
      quality: command.quality,
    });
    // captureVisibleTab is window-scoped; still bind metadata to target tab
    const body: CompanionTabResult = shot.ok
      ? {
          ok: true,
          id: command.id,
          kind: "screenshot",
          tabId,
          documentToken,
          url: shot.url,
          title: shot.title,
          capturedAt: shot.capturedAt,
          dataUrl: shot.dataUrl,
          byteLength: shot.byteLength,
          mimeType: shot.mimeType,
        }
      : {
          ok: false,
          id: command.id,
          code:
            shot.code === "restricted" ||
            shot.code === "no_tab" ||
            shot.code === "inject_failed" ||
            shot.code === "unknown"
              ? shot.code
              : "unknown",
          message: shot.message,
          tabId,
          url: shot.url,
        };
    await client.postTabResult(body);
    return;
  }

  if (command.kind === "eval") {
    const ev = await evalActiveTab(command.expression);
    const body: CompanionTabResult = ev.ok
      ? {
          ok: true,
          id: command.id,
          kind: "eval",
          tabId,
          documentToken,
          expression: ev.expression,
          result: ev.result,
          url: ev.url,
        }
      : {
          ok: false,
          id: command.id,
          code:
            ev.code === "restricted" ||
            ev.code === "no_tab" ||
            ev.code === "inject_failed" ||
            ev.code === "unknown"
              ? ev.code
              : "unknown",
          message: ev.message,
          tabId,
          url: ev.url,
        };
    await client.postTabResult(body);
    return;
  }

  if (command.kind === "console") {
    const con = await readActiveTabConsole(command.limit ?? 30);
    const body: CompanionTabResult = con.ok
      ? {
          ok: true,
          id: command.id,
          kind: "console",
          tabId,
          documentToken,
          url: con.url,
          entries: con.entries,
        }
      : {
          ok: false,
          id: command.id,
          code:
            con.code === "restricted" ||
            con.code === "no_tab" ||
            con.code === "inject_failed" ||
            con.code === "unknown"
              ? con.code
              : "unknown",
          message: con.message,
          tabId,
          url: con.url,
        };
    await client.postTabResult(body);
    return;
  }

  if (command.kind === "click" || command.kind === "type" || command.kind === "fill") {
    const targetSel = (command.ref?.trim() || command.selector?.trim() || "").trim();
    if (!targetSel) {
      await client.postTabResult({
        ok: false,
        id: command.id,
        code: "not_found",
        message: "Provide ref (preferred) or selector.",
        tabId,
      });
      return;
    }
    const action =
      command.kind === "click"
        ? { kind: "click" as const, selector: targetSel }
        : command.kind === "type"
          ? {
              kind: "type" as const,
              selector: targetSel,
              text: command.text,
              submit: command.submit,
            }
          : { kind: "fill" as const, selector: targetSel, value: command.value };

    const act = await runActiveTabAction(action, chromeTabId);
    const body: CompanionTabResult = act.ok
      ? {
          ok: true,
          id: command.id,
          kind: act.kind,
          tabId,
          documentToken,
          ref: command.ref,
          selector: act.selector,
          url: act.url,
          urlBefore: act.url,
          urlAfter: act.url,
          detail: act.detail,
          verified: act.verified,
          visibleText: act.visibleText,
        }
      : {
          ok: false,
          id: command.id,
          code:
            act.code === "restricted" ||
            act.code === "no_tab" ||
            act.code === "inject_failed" ||
            act.code === "not_found" ||
            act.code === "denied" ||
            act.code === "not_applied" ||
            act.code === "unknown"
              ? act.code
              : "unknown",
          message: act.message,
          tabId,
          url: "url" in act ? act.url : undefined,
        };
    await client.postTabResult(body);
    return;
  }

  // ---- SDD 420 P0: navigate / scroll / keys / wait / tab lifecycle ----
  if (command.kind === "navigate") {
    try {
      const tab = await chrome.tabs.get(chromeTabId);
      const urlBefore = tab.url ?? "";
      if (command.action === "goto") {
        if (!command.url) {
          await client.postTabResult({
            ok: false,
            id: command.id,
            code: "unknown",
            message: "url required for goto",
            tabId,
          });
          return;
        }
        await chrome.tabs.update(chromeTabId, { url: command.url });
      } else if (command.action === "reload") {
        await chrome.tabs.reload(chromeTabId);
      } else if (command.action === "back") {
        await chrome.scripting.executeScript({
          target: { tabId: chromeTabId },
          func: () => history.back(),
        });
      } else if (command.action === "forward") {
        await chrome.scripting.executeScript({
          target: { tabId: chromeTabId },
          func: () => history.forward(),
        });
      }
      await new Promise((r) => setTimeout(r, 200));
      const after = await chrome.tabs.get(chromeTabId);
      const { ensureHandle } = await import("./tabHandles.js");
      const h = ensureHandle(after);
      await client.postTabResult({
        ok: true,
        id: command.id,
        kind: "navigate",
        tabId: h?.tabId ?? tabId,
        documentToken: h?.documentToken,
        urlBefore,
        urlAfter: after.url,
        url: after.url,
        detail: command.action,
      });
    } catch (e) {
      await client.postTabResult({
        ok: false,
        id: command.id,
        code: "unknown",
        message: e instanceof Error ? e.message : String(e),
        tabId,
      });
    }
    return;
  }

  if (command.kind === "scroll") {
    const sel = (command.ref?.trim() || command.selector?.trim() || "").trim();
    const direction = command.direction ?? "down";
    const pixels = command.pixels ?? 400;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: chromeTabId },
        func: (d: string, px: number, selector: string) => {
          if (selector) {
            const el =
              selector.startsWith("@e")
                ? document.querySelector(`[data-tc-ref="${selector}"]`)
                : document.querySelector(selector);
            if (el) {
              el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
              return;
            }
          }
          const dx = d === "left" ? -px : d === "right" ? px : 0;
          const dy = d === "up" ? -px : d === "down" ? px : 0;
          window.scrollBy(dx, dy);
        },
        args: [direction, pixels, sel],
      });
      await client.postTabResult({
        ok: true,
        id: command.id,
        kind: "scroll",
        tabId,
        documentToken,
        detail: sel || `${direction}:${pixels}`,
      });
    } catch (e) {
      await client.postTabResult({
        ok: false,
        id: command.id,
        code: "unknown",
        message: e instanceof Error ? e.message : String(e),
        tabId,
      });
    }
    return;
  }

  if (command.kind === "press_key") {
    const sel = (command.ref?.trim() || command.selector?.trim() || "").trim();
    try {
      await chrome.scripting.executeScript({
        target: { tabId: chromeTabId },
        func: (key: string, mods: string[], selector: string) => {
          const target = selector
            ? selector.startsWith("@e")
              ? document.querySelector(`[data-tc-ref="${selector}"]`)
              : document.querySelector(selector)
            : document.activeElement ?? document.body;
          if (target instanceof HTMLElement) target.focus();
          const opts = {
            key,
            bubbles: true,
            cancelable: true,
            ctrlKey: mods.includes("Control") || mods.includes("Ctrl"),
            metaKey: mods.includes("Meta") || mods.includes("Command"),
            altKey: mods.includes("Alt"),
            shiftKey: mods.includes("Shift"),
          };
          (target ?? document).dispatchEvent(new KeyboardEvent("keydown", opts));
          (target ?? document).dispatchEvent(new KeyboardEvent("keyup", opts));
        },
        args: [command.key, command.modifiers ?? [], sel],
      });
      await client.postTabResult({
        ok: true,
        id: command.id,
        kind: "press_key",
        tabId,
        documentToken,
        detail: command.key,
      });
    } catch (e) {
      await client.postTabResult({
        ok: false,
        id: command.id,
        code: "unknown",
        message: e instanceof Error ? e.message : String(e),
        tabId,
      });
    }
    return;
  }

  if (command.kind === "wait_for") {
    const sel = (command.ref?.trim() || command.selector?.trim() || "").trim();
    const text = command.text ?? "";
    const budget = Math.min(command.timeoutMs ?? 15_000, 60_000);
    const started = Date.now();
    let okWait = false;
    try {
      while (Date.now() - started < budget) {
        if (command.what === "load") {
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: chromeTabId },
            func: () => document.readyState,
          });
          if (result === "complete" || result === "interactive") {
            okWait = true;
            break;
          }
        } else if (command.what === "element" && sel) {
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: chromeTabId },
            func: (selector: string) =>
              !!(selector.startsWith("@e")
                ? document.querySelector(`[data-tc-ref="${selector}"]`)
                : document.querySelector(selector)),
            args: [sel],
          });
          if (result) {
            okWait = true;
            break;
          }
        } else if (command.what === "text" && text) {
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: chromeTabId },
            func: (t: string) => (document.body?.innerText ?? "").includes(t),
            args: [text],
          });
          if (result) {
            okWait = true;
            break;
          }
        } else if (command.what === "navigation") {
          okWait = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      await client.postTabResult(
        okWait
          ? {
              ok: true,
              id: command.id,
              kind: "wait_for",
              tabId,
              documentToken,
              detail: command.what,
            }
          : {
              ok: false,
              id: command.id,
              code: "timeout",
              message: `wait_for ${command.what} timed out after ${budget}ms`,
              tabId,
            },
      );
    } catch (e) {
      await client.postTabResult({
        ok: false,
        id: command.id,
        code: "unknown",
        message: e instanceof Error ? e.message : String(e),
        tabId,
      });
    }
    return;
  }

  if (command.kind === "tab_activate") {
    try {
      await chrome.tabs.update(chromeTabId, { active: true });
      await client.postTabResult({
        ok: true,
        id: command.id,
        kind: "tab_activate",
        tabId,
        documentToken,
      });
    } catch (e) {
      await client.postTabResult({
        ok: false,
        id: command.id,
        code: "unknown",
        message: e instanceof Error ? e.message : String(e),
        tabId,
      });
    }
    return;
  }

  if (command.kind === "tab_close") {
    try {
      await chrome.tabs.remove(chromeTabId);
      const { dropChromeTab } = await import("./tabHandles.js");
      dropChromeTab(chromeTabId);
      await client.postTabResult({
        ok: true,
        id: command.id,
        kind: "tab_close",
        tabId,
      });
    } catch (e) {
      await client.postTabResult({
        ok: false,
        id: command.id,
        code: "unknown",
        message: e instanceof Error ? e.message : String(e),
        tabId,
      });
    }
    return;
  }

  // ---- SDD 420 P1: get / find / hover / select_option / check ----
  if (command.kind === "get") {
    const sel = (command.ref?.trim() || command.selector?.trim() || "").trim();
    if (!sel) {
      await client.postTabResult({
        ok: false,
        id: command.id,
        code: "not_found",
        message: "Provide ref (preferred) or selector.",
        tabId,
      });
      return;
    }
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: chromeTabId },
        func: (selector: string, what: string, attrName: string | undefined) => {
          const el =
            /^@e\d+$/i.test(selector)
              ? document.querySelector(`[data-tc-ref="${selector}"]`)
              : document.querySelector(selector);
          if (!el) return { ok: false as const, code: "not_found", message: `No element: ${selector}` };
          const isPassword = el instanceof HTMLInputElement && el.type === "password";
          const secretAttr = (n: string) =>
            /password|passwd|pwd|token|secret|authorization|cookie/i.test(n);
          if (what === "text") {
            const t =
              el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
                ? isPassword
                  ? "[redacted]"
                  : el.value
                : (el as HTMLElement).innerText || el.textContent || "";
            return { ok: true as const, data: t.slice(0, 8000) };
          }
          if (what === "html") {
            return { ok: true as const, data: (el as HTMLElement).outerHTML?.slice(0, 12_000) ?? "" };
          }
          if (what === "value") {
            if (isPassword) return { ok: false as const, code: "denied", message: "Password value blocked." };
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
              return { ok: true as const, data: el.value };
            }
            return { ok: true as const, data: (el as HTMLElement).innerText ?? "" };
          }
          if (what === "attribute") {
            const name = (attrName ?? "").trim();
            if (!name) return { ok: false as const, code: "unknown", message: "attribute name required" };
            if (secretAttr(name)) {
              return { ok: false as const, code: "denied", message: `Attribute '${name}' blocked (secrets).` };
            }
            return { ok: true as const, data: el.getAttribute(name) };
          }
          // state
          const he = el as HTMLElement;
          const st: Record<string, unknown> = {
            tag: el.tagName.toLowerCase(),
            visible: !!(he.offsetWidth || he.offsetHeight || he.getClientRects().length),
            disabled: "disabled" in el ? Boolean((el as HTMLInputElement).disabled) : false,
            focused: document.activeElement === el,
          };
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            st.type = el instanceof HTMLInputElement ? el.type : "textarea";
            st.readOnly = el.readOnly;
            if (el instanceof HTMLInputElement) st.checked = el.checked;
          }
          if (el instanceof HTMLSelectElement) {
            st.selectedIndex = el.selectedIndex;
            st.value = el.value;
          }
          return { ok: true as const, data: st };
        },
        args: [sel, command.what, command.attribute],
      });
      if (!result || result.ok === false) {
        await client.postTabResult({
          ok: false,
          id: command.id,
          code: (result?.code as "not_found" | "denied" | "unknown") ?? "unknown",
          message: result?.message ?? "get failed",
          tabId,
        });
        return;
      }
      await client.postTabResult({
        ok: true,
        id: command.id,
        kind: "get",
        tabId,
        documentToken,
        what: command.what,
        attribute: command.attribute,
        data: result.data,
      });
    } catch (e) {
      await client.postTabResult({
        ok: false,
        id: command.id,
        code: "unknown",
        message: e instanceof Error ? e.message : String(e),
        tabId,
      });
    }
    return;
  }

  if (command.kind === "find") {
    const needle = command.text;
    const limit = Math.min(command.limit ?? 20, 50);
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: chromeTabId },
        func: (text: string, max: number) => {
          const out: Array<{ ref?: string; selector?: string; text: string; tag?: string }> = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          let node = walker.nextNode();
          while (node && out.length < max) {
            const el = node as HTMLElement;
            const t = (el.innerText || "").trim();
            if (t && t.includes(text) && el.children.length === 0) {
              const ref = el.getAttribute("data-tc-ref") ?? undefined;
              out.push({
                ref: ref ?? undefined,
                text: t.slice(0, 200),
                tag: el.tagName.toLowerCase(),
              });
            }
            node = walker.nextNode();
          }
          // fallback: broader match on leaves with short text
          if (out.length === 0) {
            for (const el of Array.from(document.querySelectorAll("a,button,label,span,p,li,td,th,h1,h2,h3"))) {
              if (out.length >= max) break;
              const t = ((el as HTMLElement).innerText || "").trim();
              if (t.includes(text)) {
                out.push({
                  ref: el.getAttribute("data-tc-ref") ?? undefined,
                  text: t.slice(0, 200),
                  tag: el.tagName.toLowerCase(),
                });
              }
            }
          }
          return out;
        },
        args: [needle, limit],
      });
      await client.postTabResult({
        ok: true,
        id: command.id,
        kind: "find",
        tabId,
        documentToken,
        matches: result ?? [],
      });
    } catch (e) {
      await client.postTabResult({
        ok: false,
        id: command.id,
        code: "unknown",
        message: e instanceof Error ? e.message : String(e),
        tabId,
      });
    }
    return;
  }

  if (command.kind === "hover") {
    const sel = (command.ref?.trim() || command.selector?.trim() || "").trim();
    try {
      await chrome.scripting.executeScript({
        target: { tabId: chromeTabId },
        func: (selector: string) => {
          const el =
            /^@e\d+$/i.test(selector)
              ? document.querySelector(`[data-tc-ref="${selector}"]`)
              : document.querySelector(selector);
          if (!el) throw new Error(`No element: ${selector}`);
          el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
          el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
        },
        args: [sel],
      });
      await client.postTabResult({
        ok: true,
        id: command.id,
        kind: "hover",
        tabId,
        documentToken,
        detail: sel,
      });
    } catch (e) {
      await client.postTabResult({
        ok: false,
        id: command.id,
        code: "unknown",
        message: e instanceof Error ? e.message : String(e),
        tabId,
      });
    }
    return;
  }

  if (command.kind === "select_option") {
    const sel = (command.ref?.trim() || command.selector?.trim() || "").trim();
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: chromeTabId },
        func: (
          selector: string,
          value: string | undefined,
          label: string | undefined,
          index: number | undefined,
        ) => {
          const el =
            /^@e\d+$/i.test(selector)
              ? document.querySelector(`[data-tc-ref="${selector}"]`)
              : document.querySelector(selector);
          if (!(el instanceof HTMLSelectElement)) {
            return { ok: false as const, message: "Target is not a <select>" };
          }
          if (value !== undefined) {
            el.value = value;
          } else if (label !== undefined) {
            const opt = Array.from(el.options).find((o) => o.text.trim() === label || o.label === label);
            if (!opt) return { ok: false as const, message: `No option label: ${label}` };
            el.value = opt.value;
          } else if (index !== undefined) {
            if (index < 0 || index >= el.options.length) {
              return { ok: false as const, message: `index ${index} out of range` };
            }
            el.selectedIndex = index;
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true as const, detail: el.value };
        },
        args: [sel, command.value, command.label, command.index],
      });
      if (!result?.ok) {
        await client.postTabResult({
          ok: false,
          id: command.id,
          code: "not_applied",
          message: result?.message ?? "select_option failed",
          tabId,
        });
        return;
      }
      await client.postTabResult({
        ok: true,
        id: command.id,
        kind: "select_option",
        tabId,
        documentToken,
        detail: result.detail,
      });
    } catch (e) {
      await client.postTabResult({
        ok: false,
        id: command.id,
        code: "unknown",
        message: e instanceof Error ? e.message : String(e),
        tabId,
      });
    }
    return;
  }

  if (command.kind === "check") {
    const sel = (command.ref?.trim() || command.selector?.trim() || "").trim();
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: chromeTabId },
        func: (selector: string, checked: boolean) => {
          const el =
            /^@e\d+$/i.test(selector)
              ? document.querySelector(`[data-tc-ref="${selector}"]`)
              : document.querySelector(selector);
          if (!(el instanceof HTMLInputElement) || (el.type !== "checkbox" && el.type !== "radio")) {
            return { ok: false as const, message: "Target is not checkbox/radio" };
          }
          if (el.checked !== checked) {
            el.click();
          }
          return { ok: true as const, detail: el.checked ? "checked" : "unchecked" };
        },
        args: [sel, command.checked],
      });
      if (!result?.ok) {
        await client.postTabResult({
          ok: false,
          id: command.id,
          code: "not_applied",
          message: result?.message ?? "check failed",
          tabId,
        });
        return;
      }
      await client.postTabResult({
        ok: true,
        id: command.id,
        kind: "check",
        tabId,
        documentToken,
        detail: result.detail,
      });
    } catch (e) {
      await client.postTabResult({
        ok: false,
        id: command.id,
        code: "unknown",
        message: e instanceof Error ? e.message : String(e),
        tabId,
      });
    }
    return;
  }

  // tab_open is handled before resolveHandle (no target tab)
  await client.postTabResult({
    ok: false,
    id: command.id,
    code: "unknown",
    message: `Unsupported tab command kind: ${String((command as { kind?: string }).kind)}`,
  });
}

// Note: tab_open must run without resolveHandle — patch entry point
async function fulfillTabCommandEntry(client: CompanionClient, command: CompanionTabCommand): Promise<void> {
  if (command.kind === "tab_open") {
    try {
      const tab = await chrome.tabs.create({
        url: command.url ?? "about:blank",
        active: command.active !== false,
      });
      const { ensureHandle } = await import("./tabHandles.js");
      const h = ensureHandle(tab);
      if (!h) {
        await client.postTabResult({
          ok: false,
          id: command.id,
          code: "no_tab",
          message: "Failed to open tab",
        });
        return;
      }
      await client.postTabResult({
        ok: true,
        id: command.id,
        kind: "tab_open",
        tabId: h.tabId,
        documentToken: h.documentToken,
        url: h.url,
        title: h.title,
      });
    } catch (e) {
      await client.postTabResult({
        ok: false,
        id: command.id,
        code: "unknown",
        message: e instanceof Error ? e.message : String(e),
      });
    }
    return;
  }
  return fulfillTabCommand(client, command);
}

/**
 * Chrome Side Panel (same surface class as Claude in Chrome):
 * toolbar icon opens a docked browser side panel, not a tiny action popup.
 * @see https://developer.chrome.com/docs/extensions/reference/api/sidePanel
 */
function enableSidePanelOnActionClick(): void {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err: unknown) => console.error("sidePanel.setPanelBehavior failed", err));
}

chrome.runtime.onInstalled.addListener(() => {
  void writeState(defaultState());
  void writeLive(defaultLive());
  enableSidePanelOnActionClick();
});

chrome.runtime.onStartup.addListener(() => {
  enableSidePanelOnActionClick();
  void (async () => {
    const state = await readState();
    if (state.baseUrl && state.sessionToken) void startLiveStream();
  })();
});

// Service worker restarts: re-assert panel behavior + resume stream if paired.
enableSidePanelOnActionClick();
void (async () => {
  const state = await readState();
  if (state.baseUrl && state.sessionToken) void startLiveStream();
})();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (message?.type === "getLiveState" || message?.type === "getStatus") {
      const live = await readLive();
      const state = await readState();
      // Prefer live cache; fall back to stored pair status.
      if (live.stream === "live" || live.agents.length > 0 || live.connection.status === "connected") {
        sendResponse(
          message?.type === "getLiveState"
            ? live
            : {
                ...live.connection,
                baseUrl: state.baseUrl ?? live.connection.baseUrl,
                protocolVersion: COMPANION_PROTOCOL_VERSION,
                extensionVersion: chrome.runtime.getManifest().version,
              },
        );
        return;
      }
      // Cold path: one status GET if paired but stream not yet live.
      if (state.baseUrl && state.sessionToken) {
        try {
          const status = await clientFrom(state).status();
          await writeState({ ...state, status });
          sendResponse(
            message?.type === "getLiveState"
              ? {
                  ...live,
                  connection: statusView(state, status),
                  stream: live.stream,
                }
              : statusView(state, status),
          );
          return;
        } catch (error) {
          const errStatus: ConnectionStatus = {
            status: "error",
            lastError: error instanceof Error ? error.message : String(error),
            protocolVersion: COMPANION_PROTOCOL_VERSION,
          };
          sendResponse(
            message?.type === "getLiveState"
              ? { ...live, connection: statusView(state, errStatus), stream: "error", streamError: errStatus.lastError }
              : statusView(state, errStatus),
          );
          return;
        }
      }
      sendResponse(
        message?.type === "getLiveState"
          ? defaultLive()
          : statusView(state, state.status),
      );
      return;
    }

    if (message?.type === "listAgents") {
      // Always re-fetch when paired so Agents tab stays fresh if SSE lags
      // (e.g. agent started while the tab is open). Cache still updated for SSE consumers.
      const state = await readState();
      if (!state.baseUrl || !state.sessionToken) {
        const live = await readLive();
        sendResponse({ ok: true, agents: live.agents ?? [] });
        return;
      }
      try {
        const res = await clientFrom(state).listAgents();
        if (res.ok && res.agents) {
          const live = await readLive();
          await writeLive({ ...live, agents: res.agents });
        }
        sendResponse(res);
      } catch (error) {
        sendResponse({
          ok: false,
          code: "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (message?.type === "pair") {
      const baseUrl = String(message.baseUrl ?? "").replace(/\/$/, "");
      const pairCode = String(message.pairCode ?? "").trim().toUpperCase();
      if (!baseUrl || !pairCode) {
        sendResponse({ ok: false, code: "unknown", message: "baseUrl and pairCode are required" });
        return;
      }
      try {
        // Best-effort: ensure host access (side panel should request first; SW may be limited).
        await ensureEngineHostPermission(baseUrl);
        const client = new CompanionClient({ baseUrl });
        const result = await client.pair({
          pairCode,
          client: {
            kind: "browser",
            name: "Tachyon Companion",
            version: chrome.runtime.getManifest().version,
          },
        });
        if (!result.ok) {
          sendResponse(result);
          return;
        }
        const status: ConnectionStatus = {
          status: "connected",
          engine: result.engine,
          expiresAt: result.expiresAt,
          protocolVersion: COMPANION_PROTOCOL_VERSION,
        };
        const next: StoredState = {
          baseUrl,
          sessionToken: result.sessionToken,
          status,
        };
        await writeState(next);
        await writeLive({
          connection: statusView(next, status),
          agents: [],
          seq: 0,
          stream: "connecting",
        });
        void startLiveStream();
        sendResponse({ ok: true, status, baseUrl });
      } catch (error) {
        // Never leave an uncaught promise — UI must be able to reset and retry.
        sendResponse({
          ok: false,
          code: "engine_offline",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (message?.type === "unpair" || message?.type === "resetPairing") {
      stopLiveStream();
      const state = await readState();
      if (state.baseUrl && state.sessionToken) {
        await clientFrom(state).unpair();
      }
      const { clearAllHandles } = await import("./tabHandles.js");
      clearAllHandles();
      await writeState(defaultState());
      await writeLive(defaultLive());
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "sendPrompt") {
      const state = await readState();
      if (!state.baseUrl || !state.sessionToken) {
        sendResponse({ ok: false, code: "unpaired", message: "Not paired." });
        return;
      }
      try {
        sendResponse(
          await clientFrom(state).sendPrompt(String(message.agent ?? ""), String(message.text ?? "")),
        );
        // Engine also pushes via SSE; no manual refresh.
      } catch (error) {
        sendResponse({
          ok: false,
          code: "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    // ─── Tab control (read + act) ────────────────────────────────────────────
    if (message?.type === "captureTabSnapshot") {
      try {
        sendResponse(await captureActiveTabSnapshot());
      } catch (error) {
        sendResponse({
          ok: false,
          code: "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (message?.type === "runTabAction") {
      try {
        sendResponse(await runActiveTabAction(message.action));
      } catch (error) {
        sendResponse({
          ok: false,
          code: "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (message?.type === "captureTabScreenshot") {
      try {
        sendResponse(
          await captureActiveTabScreenshot({
            format: message.format,
            quality: message.quality,
          }),
        );
      } catch (error) {
        sendResponse({
          ok: false,
          code: "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (message?.type === "getActiveTabMeta") {
      try {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const t = tabs[0];
        sendResponse({
          ok: true,
          tabId: t?.id,
          url: t?.url,
          title: t?.title,
        });
      } catch (error) {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (message?.type === "listApprovals") {
      const state = await readState();
      if (!state.baseUrl || !state.sessionToken) {
        sendResponse({ ok: false, code: "unpaired", message: "Not paired." });
        return;
      }
      try {
        sendResponse(await clientFrom(state).listApprovals());
      } catch (error) {
        sendResponse({
          ok: false,
          code: "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (message?.type === "resolveApproval") {
      const state = await readState();
      if (!state.baseUrl || !state.sessionToken) {
        sendResponse({ ok: false, code: "unpaired", message: "Not paired." });
        return;
      }
      try {
        sendResponse(
          await clientFrom(state).resolveApproval({
            id: String(message.id ?? ""),
            decision: message.decision === "denied" ? "denied" : "approved",
          }),
        );
      } catch (error) {
        sendResponse({
          ok: false,
          code: "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (message?.type === "getTrust") {
      const { readTrust, hasAgentHostAccess } = await import("./trust.js");
      const policy = await readTrust();
      const hostAccess = await hasAgentHostAccess();
      sendResponse({ ok: true, policy, hostAccess });
      return;
    }

    if (message?.type === "setTrust") {
      // Host permission is requested in the side panel (user gesture). SW only persists policy.
      const { writeTrust, hasAgentHostAccess } = await import("./trust.js");
      const agentTabRead = message.agentTabRead === "on" ? "on" : "off";
      if (agentTabRead === "on") {
        const hostAccess = await hasAgentHostAccess();
        if (!hostAccess) {
          sendResponse({
            ok: false,
            message:
              "Host permission not granted yet. Toggle again and accept the Chrome permission dialog.",
          });
          return;
        }
        await writeTrust({ agentTabRead: "on", hostAccessGrantedAt: new Date().toISOString() });
      } else {
        await writeTrust({ agentTabRead: "off", hostAccessGrantedAt: undefined });
      }
      const policy = await (await import("./trust.js")).readTrust();
      const hostAccess = await hasAgentHostAccess();
      sendResponse({ ok: true, policy, hostAccess });
      return;
    }

    sendResponse({ ok: false, error: "unknown_message" });
  })();
  return true;
});
