/**
 * Companion protocol shapes — client mirror of the Tachyon engine companion API.
 * Server owns semantics and protocolVersion; bump only in lockstep with the engine.
 *
 * SDD 414 (tachyon repo): docs/specs/414-browser-user-companion
 */

/** Current client-supported protocol major. Engine must advertise a compatible version. */
export const COMPANION_PROTOCOL_VERSION = 2 as const;

export type ProtocolVersion = typeof COMPANION_PROTOCOL_VERSION;

export type PairStatus = "disconnected" | "pairing" | "connected" | "expired" | "error";

export interface EngineIdentity {
  /** Workspace or engine label for UI (not a secret). */
  label: string;
  /** Opaque engine instance id if the server provides one. */
  engineId?: string;
  protocolVersion: number;
}

export interface PairRequest {
  /** Short-lived code shown in Tachyon Control (or equivalent). */
  pairCode: string;
  /** Client-reported protocol version. */
  protocolVersion: ProtocolVersion;
  /** Extension / app identity for audit. */
  client: {
    kind: "browser" | "mobile";
    name: string;
    version: string;
  };
}

export interface PairSuccess {
  ok: true;
  /** Companion-scoped session token — never the agent Bridge token. */
  sessionToken: string;
  expiresAt: string;
  engine: EngineIdentity;
}

export interface PairFailure {
  ok: false;
  code:
    | "invalid_code"
    | "expired_code"
    | "protocol_mismatch"
    | "engine_offline"
    | "already_paired"
    | "unknown";
  message: string;
  /** Present on protocol_mismatch. */
  serverProtocolVersion?: number;
}

export type PairResponse = PairSuccess | PairFailure;

/** Human-push capture (v1). Never includes cookies or credentials. */
export interface SendCaptureRequest {
  url: string;
  title: string;
  /** Optional selected text from the page. */
  selection?: string;
  capturedAt: string;
  source: {
    kind: "browser";
    extensionVersion: string;
  };
}

export interface SendCaptureSuccess {
  ok: true;
  taskId: string;
}

export interface SendCaptureFailure {
  ok: false;
  code: "unpaired" | "expired" | "invalid_payload" | "engine_offline" | "unknown";
  message: string;
}

export type SendCaptureResponse = SendCaptureSuccess | SendCaptureFailure;

export interface ApprovalSummary {
  id: string;
  requester?: string;
  reason: string;
  proposedAction: string;
  risk: string;
  exactPrompt?: string;
  createdAt: string;
  status: "pending" | "approved" | "denied" | "cancelled";
}

export interface ListApprovalsSuccess {
  ok: true;
  approvals: ApprovalSummary[];
}

export interface ListApprovalsFailure {
  ok: false;
  code: "unpaired" | "expired" | "engine_offline" | "unknown";
  message: string;
}

export type ListApprovalsResponse = ListApprovalsSuccess | ListApprovalsFailure;

export interface ResolveApprovalRequest {
  id: string;
  decision: "approved" | "denied";
}

export interface ResolveApprovalSuccess {
  ok: true;
  id: string;
  status: "approved" | "denied";
}

export interface ResolveApprovalFailure {
  ok: false;
  code: "unpaired" | "expired" | "not_found" | "not_pending" | "engine_offline" | "unknown";
  message: string;
}

export type ResolveApprovalResponse = ResolveApprovalSuccess | ResolveApprovalFailure;

export interface ConnectionStatus {
  status: PairStatus;
  engine?: EngineIdentity;
  /** ISO expiry of the companion session, if connected. */
  expiresAt?: string;
  lastError?: string;
  protocolVersion?: number;
}

/** Assert client/server protocol compatibility (client-side helper). */
export function isProtocolCompatible(serverVersion: number, clientVersion: ProtocolVersion = COMPANION_PROTOCOL_VERSION): boolean {
  return serverVersion === clientVersion;
}

/** Running agent for send-prompt UI (MVP item 3 — evolving). */
export interface CompanionAgentRow {
  name: string;
  attention: string;
  composerOccupied: boolean;
}

export type ListAgentsResponse =
  | { ok: true; agents: CompanionAgentRow[] }
  | { ok: false; code: "unpaired" | "expired" | "unknown"; message: string };

export type SendPromptResponse =
  | {
      ok: true;
      status: "notified" | "queued";
      agent: string;
      dropped?: number;
      queued?: number;
    }
  | {
      ok: false;
      code:
        | "unpaired"
        | "expired"
        | "not_agent"
        | "not_running"
        | "not_ready"
        | "empty"
        | "unknown";
      message: string;
    };

/**
 * Live state pushed on GET /companion/v1/events (SSE).
 * Full snapshots — engine and client stay in lockstep without UI polling.
 */
export interface CompanionLiveState {
  seq: number;
  at: string;
  connection: ConnectionStatus;
  agents: CompanionAgentRow[];
}

/** Opaque companion tab handle (never raw Chrome tab id on the agent wire). */
export type CompanionTabId = string;

/** Target fields shared by tab-scoped commands (SDD 420). */
export interface CompanionTabTarget {
  /** Opaque handle from tabs_list / snapshot. */
  tabId: string;
  /** Optional document generation token; mismatch → stale_tab. */
  expectedDocumentToken?: string;
}

/** Engine → extension: read, act, or first-person capture (tab-scoped). */
export type CompanionTabCommand =
  | { id: string; kind: "tabs_list"; at: string }
  | ({ id: string; kind: "snapshot"; at: string } & CompanionTabTarget)
  | ({
      id: string;
      kind: "screenshot";
      at: string;
      format?: "jpeg" | "png";
      quality?: number;
      scope?: "viewport" | "full_page" | "element";
      ref?: string;
      selector?: string;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "click";
      at: string;
      ref?: string;
      selector?: string;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "type";
      at: string;
      ref?: string;
      selector?: string;
      text: string;
      submit?: boolean;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "fill";
      at: string;
      ref?: string;
      selector?: string;
      value: string;
    } & CompanionTabTarget)
  | ({ id: string; kind: "eval"; at: string; expression: string } & CompanionTabTarget)
  | ({ id: string; kind: "console"; at: string; limit?: number } & CompanionTabTarget)
  | ({
      id: string;
      kind: "navigate";
      at: string;
      action: "goto" | "back" | "forward" | "reload";
      url?: string;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "scroll";
      at: string;
      direction?: "up" | "down" | "left" | "right";
      pixels?: number;
      ref?: string;
      selector?: string;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "press_key";
      at: string;
      key: string;
      modifiers?: string[];
      ref?: string;
      selector?: string;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "wait_for";
      at: string;
      what: "element" | "text" | "navigation" | "load";
      ref?: string;
      selector?: string;
      text?: string;
      timeoutMs?: number;
    } & CompanionTabTarget)
  | {
      id: string;
      kind: "tab_open";
      at: string;
      url?: string;
      active?: boolean;
    }
  | ({ id: string; kind: "tab_activate"; at: string } & CompanionTabTarget)
  | ({ id: string; kind: "tab_close"; at: string } & CompanionTabTarget)
  | ({
      id: string;
      kind: "get";
      at: string;
      what: "text" | "html" | "value" | "attribute" | "state";
      attribute?: string;
      ref?: string;
      selector?: string;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "find";
      at: string;
      text: string;
      limit?: number;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "hover";
      at: string;
      ref?: string;
      selector?: string;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "select_option";
      at: string;
      ref?: string;
      selector?: string;
      value?: string;
      label?: string;
      index?: number;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "check";
      at: string;
      ref?: string;
      selector?: string;
      checked: boolean;
    } & CompanionTabTarget);

export type CompanionTabErrorCode =
  | "timeout"
  | "offline"
  | "denied"
  | "restricted"
  | "no_tab"
  | "inject_failed"
  | "not_found"
  | "not_applied"
  | "stale_tab"
  | "stale_ref"
  | "needs_confirm"
  | "unknown_outcome"
  | "unknown";

export interface CompanionTabRefEntry {
  ref: string;
  selector?: string;
  tag?: string;
  role?: string;
  name?: string;
}

/** Extension → engine: fulfillment of a tab command. */
export type CompanionTabResult =
  | {
      ok: true;
      id: string;
      kind: "tabs_list";
      tabs: Array<{
        tabId: string;
        title: string;
        url: string;
        active: boolean;
        documentToken: string;
      }>;
    }
  | {
      ok: true;
      id: string;
      kind: "snapshot";
      tabId: string;
      documentToken: string;
      url: string;
      title: string;
      capturedAt: string;
      selection?: string;
      outline: string;
      refs?: CompanionTabRefEntry[];
      stats: { nodes: number; truncated: boolean; outlineChars: number };
    }
  | {
      ok: true;
      id: string;
      kind: "screenshot";
      tabId: string;
      documentToken?: string;
      url: string;
      title: string;
      capturedAt: string;
      dataUrl: string;
      byteLength: number;
      mimeType: string;
    }
  | {
      ok: true;
      id: string;
      kind: "click" | "type" | "fill";
      tabId: string;
      documentToken?: string;
      ref?: string;
      selector?: string;
      url?: string;
      urlBefore?: string;
      urlAfter?: string;
      detail?: string;
      verified?: boolean;
      visibleText?: string;
    }
  | {
      ok: true;
      id: string;
      kind: "eval";
      tabId: string;
      documentToken?: string;
      expression: string;
      result: string;
      url?: string;
    }
  | {
      ok: true;
      id: string;
      kind: "console";
      tabId: string;
      documentToken?: string;
      url?: string;
      entries: Array<{ level: string; text: string; at?: string }>;
    }
  | {
      ok: true;
      id: string;
      kind:
        | "navigate"
        | "scroll"
        | "press_key"
        | "wait_for"
        | "tab_activate"
        | "tab_close"
        | "hover"
        | "select_option"
        | "check";
      tabId: string;
      documentToken?: string;
      url?: string;
      urlBefore?: string;
      urlAfter?: string;
      detail?: string;
    }
  | {
      ok: true;
      id: string;
      kind: "tab_open";
      tabId: string;
      documentToken: string;
      url: string;
      title: string;
    }
  | {
      ok: true;
      id: string;
      kind: "get";
      tabId: string;
      documentToken?: string;
      url?: string;
      what: "text" | "html" | "value" | "attribute" | "state";
      attribute?: string;
      data: unknown;
    }
  | {
      ok: true;
      id: string;
      kind: "find";
      tabId: string;
      documentToken?: string;
      url?: string;
      matches: Array<{
        ref?: string;
        selector?: string;
        text: string;
        tag?: string;
      }>;
    }
  | {
      ok: false;
      id: string;
      code: CompanionTabErrorCode;
      message: string;
      tabId?: string;
      url?: string;
      documentToken?: string;
    };

/** @deprecated Use CompanionTabResult */
export type CompanionTabSnapshotResult = CompanionTabResult;
