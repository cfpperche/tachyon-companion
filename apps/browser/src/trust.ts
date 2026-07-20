/**
 * Companion tab trust policy (SDD 414 / t-e05d2d).
 * Controls whether the engine/agent may request DOM reads of the user's tab.
 */

const TRUST_KEY = "tachyonCompanion.trust.v1";

export type AgentTabReadMode = "off" | "on";

export interface TrustPolicy {
  /**
   * When on, the paired engine may request active-tab DOM snapshots
   * (tool user_browser_snapshot). Requires optional host permissions for inject without gesture.
   */
  agentTabRead: AgentTabReadMode;
  /** ISO time when host permissions were last granted (if known). */
  hostAccessGrantedAt?: string;
}

export const DEFAULT_TRUST: TrustPolicy = {
  agentTabRead: "off",
};

export async function readTrust(): Promise<TrustPolicy> {
  const bag = await chrome.storage.local.get(TRUST_KEY);
  const raw = bag[TRUST_KEY] as TrustPolicy | undefined;
  if (!raw || (raw.agentTabRead !== "on" && raw.agentTabRead !== "off")) {
    return { ...DEFAULT_TRUST };
  }
  return { ...DEFAULT_TRUST, ...raw };
}

export async function writeTrust(policy: TrustPolicy): Promise<void> {
  await chrome.storage.local.set({ [TRUST_KEY]: policy });
}

/**
 * Host access for agent-initiated inject + captureVisibleTab.
 * Chrome requires literally `<all_urls>` (or activeTab user-gesture) for
 * tabs.captureVisibleTab — http(s) patterns alone are not enough for screenshots.
 */
export const AGENT_TAB_ORIGINS = ["<all_urls>"] as const;

export async function hasAgentHostAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [...AGENT_TAB_ORIGINS] });
  } catch {
    return false;
  }
}

/**
 * Request broad http(s) host access. Must run from a user gesture (Settings toggle).
 */
export async function requestAgentHostAccess(): Promise<boolean> {
  try {
    const ok = await chrome.permissions.request({ origins: [...AGENT_TAB_ORIGINS] });
    if (ok) {
      const t = await readTrust();
      await writeTrust({ ...t, hostAccessGrantedAt: new Date().toISOString() });
    }
    return ok;
  } catch {
    return false;
  }
}

export async function removeAgentHostAccess(): Promise<void> {
  try {
    await chrome.permissions.remove({ origins: [...AGENT_TAB_ORIGINS] });
  } catch {
    /* ignore */
  }
  const t = await readTrust();
  await writeTrust({ ...t, agentTabRead: "off", hostAccessGrantedAt: undefined });
}
