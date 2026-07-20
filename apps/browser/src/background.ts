/**
 * Service worker — pairing + connection state (SDD 414 slice 2 client).
 */

import { CompanionClient } from "@tachyon-companion/api-client";
import {
  COMPANION_PROTOCOL_VERSION,
  type ConnectionStatus,
} from "@tachyon-companion/protocol";

const STORAGE_KEY = "tachyonCompanion.v1";

interface StoredState {
  baseUrl?: string;
  sessionToken?: string;
  status: ConnectionStatus;
}

const defaultState = (): StoredState => ({
  status: { status: "disconnected", protocolVersion: COMPANION_PROTOCOL_VERSION },
});

async function readState(): Promise<StoredState> {
  const bag = await chrome.storage.local.get(STORAGE_KEY);
  const raw = bag[STORAGE_KEY] as StoredState | undefined;
  return raw ?? defaultState();
}

async function writeState(state: StoredState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function clientFrom(state: StoredState): CompanionClient {
  return new CompanionClient({
    baseUrl: state.baseUrl,
    sessionToken: state.sessionToken,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void writeState(defaultState());
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (message?.type === "getStatus") {
      const state = await readState();
      let status = state.status;
      if (state.baseUrl && state.sessionToken) {
        try {
          status = await clientFrom(state).status();
          await writeState({ ...state, status });
        } catch (error) {
          status = {
            status: "error",
            lastError: error instanceof Error ? error.message : String(error),
            protocolVersion: COMPANION_PROTOCOL_VERSION,
          };
        }
      }
      sendResponse({
        ...status,
        baseUrl: state.baseUrl,
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        extensionVersion: chrome.runtime.getManifest().version,
      });
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
      await writeState({
        baseUrl,
        sessionToken: result.sessionToken,
        status,
      });
      sendResponse({ ok: true, status, baseUrl });
      return;
    }

    if (message?.type === "unpair" || message?.type === "resetPairing") {
      const state = await readState();
      if (state.baseUrl && state.sessionToken) {
        await clientFrom(state).unpair();
      }
      await writeState(defaultState());
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "unknown_message" });
  })();
  return true;
});
