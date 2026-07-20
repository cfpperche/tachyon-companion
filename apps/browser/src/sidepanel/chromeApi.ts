/** Thin wrappers over extension messaging (live backend). */

export type ConnectionView = {
  status: string;
  baseUrl?: string;
  engine?: { label?: string };
  protocolVersion?: number;
  extensionVersion?: string;
  lastError?: string;
};

export type AgentView = {
  name: string;
  attention: string;
  composerOccupied?: boolean;
};

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
