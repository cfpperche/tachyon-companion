/** Thin wrappers over extension messaging (live backend + live state). */

import type {
  ApprovalSummary,
  CompanionAgentRow,
  ConnectionStatus,
  ListApprovalsResponse,
  ResolveApprovalResponse,
} from "@tachyon-companion/protocol";

export type ConnectionView = ConnectionStatus & {
  baseUrl?: string;
  extensionVersion?: string;
};

export type AgentView = CompanionAgentRow;

export type LiveView = {
  connection: ConnectionView;
  agents: AgentView[];
  seq: number;
  at?: string;
  stream: "idle" | "connecting" | "live" | "reconnecting" | "error";
  streamError?: string;
};

export async function getLiveState(): Promise<LiveView> {
  return chrome.runtime.sendMessage({ type: "getLiveState" });
}

export async function getStatus(): Promise<ConnectionView> {
  return chrome.runtime.sendMessage({ type: "getStatus" });
}

export async function pair(baseUrl: string, pairCode: string): Promise<{ ok: boolean; message?: string; code?: string }> {
  return chrome.runtime.sendMessage({ type: "pair", baseUrl, pairCode });
}

export async function unpair(): Promise<void> {
  await chrome.runtime.sendMessage({ type: "unpair" });
}

export async function listAgents(): Promise<{ ok: boolean; agents?: AgentView[]; message?: string }> {
  return chrome.runtime.sendMessage({ type: "listAgents" });
}

export async function sendPrompt(
  agent: string,
  text: string,
): Promise<{ ok: boolean; status?: string; agent?: string; message?: string; code?: string }> {
  return chrome.runtime.sendMessage({ type: "sendPrompt", agent, text });
}

/** Active tab meta (url/title) — may be empty without host permission until capture gesture. */
export async function getActiveTabMeta(): Promise<{
  ok: boolean;
  tabId?: number;
  url?: string;
  title?: string;
  message?: string;
}> {
  return chrome.runtime.sendMessage({ type: "getActiveTabMeta" });
}

/** DOM outline of the user's active tab (content-script, read-only). */
export type TabSnapshotResponse =
  | {
      ok: true;
      url: string;
      title: string;
      capturedAt: string;
      selection?: string;
      outline: string;
      stats: { nodes: number; truncated: boolean; outlineChars: number };
    }
  | {
      ok: false;
      code?: string;
      message: string;
      url?: string;
    };

export async function captureTabSnapshot(): Promise<TabSnapshotResponse> {
  return chrome.runtime.sendMessage({ type: "captureTabSnapshot" });
}

export type TabActionResponse =
  | { ok: true; kind: string; selector: string; detail?: string; url?: string }
  | { ok: false; code?: string; message: string; url?: string };

export async function runTabAction(action: {
  kind: "click" | "type" | "fill";
  selector: string;
  text?: string;
  value?: string;
  submit?: boolean;
}): Promise<TabActionResponse> {
  return chrome.runtime.sendMessage({ type: "runTabAction", action });
}

export type TrustPolicyView = {
  agentTabRead: "off" | "on";
  hostAccessGrantedAt?: string;
};

export async function getTrust(): Promise<{
  ok: boolean;
  policy?: TrustPolicyView;
  hostAccess?: boolean;
  message?: string;
}> {
  return chrome.runtime.sendMessage({ type: "getTrust" });
}

const AGENT_TAB_ORIGINS = ["http://*/*", "https://*/*"] as const;

/**
 * Enable/disable agent tab reads.
 * Host permission MUST be requested from the side panel (user gesture) —
 * chrome.permissions.request fails if called only from the service worker.
 */
export async function listApprovals(): Promise<ListApprovalsResponse> {
  return chrome.runtime.sendMessage({ type: "listApprovals" });
}

export async function resolveApproval(
  id: string,
  decision: "approved" | "denied",
): Promise<ResolveApprovalResponse> {
  return chrome.runtime.sendMessage({ type: "resolveApproval", id, decision });
}

export type { ApprovalSummary };

export async function setTrust(agentTabRead: "off" | "on"): Promise<{
  ok: boolean;
  policy?: TrustPolicyView;
  hostAccess?: boolean;
  message?: string;
}> {
  if (agentTabRead === "on") {
    try {
      const already = await chrome.permissions.contains({ origins: [...AGENT_TAB_ORIGINS] });
      if (!already) {
        const granted = await chrome.permissions.request({ origins: [...AGENT_TAB_ORIGINS] });
        if (!granted) {
          return {
            ok: false,
            message:
              "Host permission denied. Accept the Chrome permission dialog to allow agent tab reads on http(s) pages.",
          };
        }
      }
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : "Could not request host permission.",
      };
    }
  } else {
    try {
      await chrome.permissions.remove({ origins: [...AGENT_TAB_ORIGINS] });
    } catch {
      /* ignore */
    }
  }
  return chrome.runtime.sendMessage({ type: "setTrust", agentTabRead });
}

/** Subscribe to live state pushed by the service worker (SSE → storage/message). */
export function subscribeLiveState(onState: (state: LiveView) => void): () => void {
  const onMessage = (message: { type?: string; state?: LiveView }) => {
    if (message?.type === "liveState" && message.state) onState(message.state);
  };
  const onStorage = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== "local") return;
    const ch = changes["tachyonCompanion.live.v1"];
    if (ch?.newValue) onState(ch.newValue as LiveView);
  };
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorage);
  return () => {
    chrome.runtime.onMessage.removeListener(onMessage);
    chrome.storage.onChanged.removeListener(onStorage);
  };
}
