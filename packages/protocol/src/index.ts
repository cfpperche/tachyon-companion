/**
 * Companion protocol shapes — client mirror of the Tachyon engine companion API.
 * Server owns semantics and protocolVersion; bump only in lockstep with the engine.
 *
 * SDD 414 (tachyon repo): docs/specs/414-browser-user-companion
 */

/** Current client-supported protocol major. Engine must advertise a compatible version. */
export const COMPANION_PROTOCOL_VERSION = 1 as const;

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
  reason: string;
  proposedAction: string;
  risk: string;
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
}

/** Assert client/server protocol compatibility (client-side helper). */
export function isProtocolCompatible(serverVersion: number, clientVersion: ProtocolVersion = COMPANION_PROTOCOL_VERSION): boolean {
  return serverVersion === clientVersion;
}
