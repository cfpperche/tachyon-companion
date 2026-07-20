/**
 * Service worker — connection state only in v0.1 scaffold.
 * Pairing transport lands with ADE SDD 414 slice 2.
 */

import { COMPANION_PROTOCOL_VERSION, type ConnectionStatus } from "@tachyon-companion/protocol";

const STORAGE_KEY = "tachyonCompanion.v1";

interface StoredState {
  baseUrl?: string;
  sessionToken?: string;
  status: ConnectionStatus;
}

const defaultState = (): StoredState => ({
  status: { status: "disconnected" },
});

async function readState(): Promise<StoredState> {
  const bag = await chrome.storage.local.get(STORAGE_KEY);
  const raw = bag[STORAGE_KEY] as StoredState | undefined;
  return raw ?? defaultState();
}

async function writeState(state: StoredState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

chrome.runtime.onInstalled.addListener(() => {
  void writeState(defaultState());
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (message?.type === "getStatus") {
      const state = await readState();
      sendResponse({
        ...state.status,
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        extensionVersion: chrome.runtime.getManifest().version,
      });
      return;
    }
    if (message?.type === "resetPairing") {
      await writeState(defaultState());
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: "unknown_message" });
  })();
  return true;
});
