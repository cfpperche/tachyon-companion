/** Thin wrappers over extension messaging (live backend + live state). */

import type { CompanionAgentRow, ConnectionStatus } from "@tachyon-companion/protocol";

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
