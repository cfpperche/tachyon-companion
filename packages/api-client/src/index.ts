/**
 * Companion API client stubs.
 * Real loopback transport lands when ADE slice 2 (pairing) ships.
 */

import {
  COMPANION_PROTOCOL_VERSION,
  type ConnectionStatus,
  type ListAgentsResponse,
  type ListApprovalsResponse,
  type PairRequest,
  type PairResponse,
  type ResolveApprovalRequest,
  type ResolveApprovalResponse,
  type SendCaptureRequest,
  type SendCaptureResponse,
  type SendPromptResponse,
} from "@tachyon-companion/protocol";

export interface CompanionClientOptions {
  /** Base URL of the local engine companion endpoint (e.g. http://127.0.0.1:PORT). */
  baseUrl?: string;
  /** Companion session token after successful pair. */
  sessionToken?: string;
  /** Fetch implementation (injectable for tests). */
  fetch?: typeof fetch;
}

export class CompanionClient {
  private baseUrl: string | undefined;
  private sessionToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CompanionClientOptions = {}) {
    this.baseUrl = options.baseUrl;
    this.sessionToken = options.sessionToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get protocolVersion(): number {
    return COMPANION_PROTOCOL_VERSION;
  }

  setSession(token: string | undefined): void {
    this.sessionToken = token;
  }

  setBaseUrl(url: string | undefined): void {
    this.baseUrl = url;
  }

  /**
   * Pair with a short-lived code from Tachyon Control.
   * Stub: returns engine_offline until the ADE pairing endpoint exists.
   */
  async pair(request: Omit<PairRequest, "protocolVersion"> & { protocolVersion?: number }): Promise<PairResponse> {
    if (!this.baseUrl) {
      return {
        ok: false,
        code: "engine_offline",
        message: "No companion base URL configured. Pairing endpoint lands with ADE SDD 414 slice 2.",
      };
    }
    return this.postJson<PairResponse>("/companion/v1/pair", {
      ...request,
      protocolVersion: request.protocolVersion ?? COMPANION_PROTOCOL_VERSION,
    });
  }

  async unpair(): Promise<{ ok: boolean; message?: string }> {
    if (!this.baseUrl || !this.sessionToken) {
      this.sessionToken = undefined;
      return { ok: true };
    }
    try {
      await this.postJson("/companion/v1/unpair", {});
    } catch {
      /* best-effort */
    }
    this.sessionToken = undefined;
    return { ok: true };
  }

  async status(): Promise<ConnectionStatus> {
    if (!this.baseUrl || !this.sessionToken) {
      return { status: "disconnected" };
    }
    try {
      return await this.getJson<ConnectionStatus>("/companion/v1/status");
    } catch (error) {
      return {
        status: "error",
        lastError: error instanceof Error ? error.message : "status failed",
      };
    }
  }

  async sendCapture(body: SendCaptureRequest): Promise<SendCaptureResponse> {
    if (!this.baseUrl || !this.sessionToken) {
      return { ok: false, code: "unpaired", message: "Not paired with a Tachyon engine." };
    }
    return this.postJson<SendCaptureResponse>("/companion/v1/capture", body);
  }

  async listAgents(): Promise<ListAgentsResponse> {
    if (!this.baseUrl || !this.sessionToken) {
      return { ok: false, code: "unpaired", message: "Not paired with a Tachyon engine." };
    }
    return this.getJson<ListAgentsResponse>("/companion/v1/agents");
  }

  async sendPrompt(agent: string, text: string): Promise<SendPromptResponse> {
    if (!this.baseUrl || !this.sessionToken) {
      return { ok: false, code: "unpaired", message: "Not paired with a Tachyon engine." };
    }
    return this.postJson<SendPromptResponse>("/companion/v1/prompt", { agent, text });
  }

  async listApprovals(): Promise<ListApprovalsResponse> {
    if (!this.baseUrl || !this.sessionToken) {
      return { ok: false, code: "unpaired", message: "Not paired with a Tachyon engine." };
    }
    return this.getJson<ListApprovalsResponse>("/companion/v1/approvals");
  }

  async resolveApproval(body: ResolveApprovalRequest): Promise<ResolveApprovalResponse> {
    if (!this.baseUrl || !this.sessionToken) {
      return { ok: false, code: "unpaired", message: "Not paired with a Tachyon engine." };
    }
    return this.postJson<ResolveApprovalResponse>("/companion/v1/approvals/resolve", body);
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(this.url(path), {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`GET ${path} → ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok && res.headers.get("content-type")?.includes("application/json")) {
      return (await res.json()) as T;
    }
    if (!res.ok) {
      throw new Error(`POST ${path} → ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private url(path: string): string {
    if (!this.baseUrl) throw new Error("baseUrl required");
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json" };
    if (this.sessionToken) h.authorization = `Bearer ${this.sessionToken}`;
    return h;
  }
}

export { COMPANION_PROTOCOL_VERSION };
