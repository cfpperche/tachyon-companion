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
import { captureActiveTabSnapshot, runActiveTabAction } from "./tabBridge.js";
import { readTrust } from "./trust.js";

const STORAGE_KEY = "tachyonCompanion.v1";
const LIVE_KEY = "tachyonCompanion.live.v1";

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
          // Agent tool user_browser_snapshot (or similar) — fulfill if trust allows.
          void fulfillTabCommand(client, ev.command).catch((err) => {
            console.error("tab.command fulfill failed", err);
          });
        } else if (ev.type === "approvals.changed") {
          try {
            await chrome.runtime.sendMessage({ type: "approvalsChanged", id: ev.id, decision: ev.decision });
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

/** Handle engine tab.command — trust-gated read/act (t-2a7010 + t-fbe280). */
async function fulfillTabCommand(client: CompanionClient, command: CompanionTabCommand): Promise<void> {
  const trust = await readTrust();
  if (trust.agentTabRead !== "on") {
    await client.postTabResult({
      ok: false,
      id: command.id,
      code: "denied",
      message:
        "Agent tab access is off. Enable “Allow agent tab reads” in Companion Settings (host access for http/https).",
    });
    return;
  }

  if (command.kind === "snapshot") {
    const snap = await captureActiveTabSnapshot();
    const body: CompanionTabResult = snap.ok
      ? {
          ok: true,
          id: command.id,
          kind: "snapshot",
          url: snap.url,
          title: snap.title,
          capturedAt: snap.capturedAt,
          selection: snap.selection,
          outline: snap.outline,
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
          url: snap.url,
        };
    await client.postTabResult(body);
    return;
  }

  if (command.kind === "click" || command.kind === "type" || command.kind === "fill") {
    const action =
      command.kind === "click"
        ? { kind: "click" as const, selector: command.selector }
        : command.kind === "type"
          ? {
              kind: "type" as const,
              selector: command.selector,
              text: command.text,
              submit: command.submit,
            }
          : { kind: "fill" as const, selector: command.selector, value: command.value };

    const act = await runActiveTabAction(action);
    const body: CompanionTabResult = act.ok
      ? {
          ok: true,
          id: command.id,
          kind: act.kind,
          selector: act.selector,
          url: act.url,
          detail: act.detail,
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
            act.code === "unknown"
              ? act.code
              : "unknown",
          message: act.message,
          url: "url" in act ? act.url : undefined,
        };
    await client.postTabResult(body);
    return;
  }

  await client.postTabResult({
    ok: false,
    id: command.id,
    code: "unknown",
    message: `Unsupported tab command kind: ${String((command as { kind?: string }).kind)}`,
  });
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
      const live = await readLive();
      if (live.stream === "live" || live.agents.length > 0) {
        sendResponse({ ok: true, agents: live.agents });
        return;
      }
      const state = await readState();
      if (!state.baseUrl || !state.sessionToken) {
        sendResponse({ ok: false, code: "unpaired", message: "Not paired." });
        return;
      }
      try {
        sendResponse(await clientFrom(state).listAgents());
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
        sendResponse({ ok: false, message: "baseUrl and pairCode are required" });
        return;
      }
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
      return;
    }

    if (message?.type === "unpair" || message?.type === "resetPairing") {
      stopLiveStream();
      const state = await readState();
      if (state.baseUrl && state.sessionToken) {
        await clientFrom(state).unpair();
      }
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
