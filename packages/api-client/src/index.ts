/**
 * Companion API client stubs.
 * Real loopback transport lands when ADE slice 2 (pairing) ships.
 */

import {
  COMPANION_PROTOCOL_VERSION,
  type CompanionLiveState,
  type CompanionTabCommand,
  type CompanionTabResult,
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
   * Network/permission failures return structured PairResponse (never throw) so the UI can recover.
   */
  async pair(
    request: Omit<PairRequest, "protocolVersion"> & { protocolVersion?: number },
    opts?: { signal?: AbortSignal },
  ): Promise<PairResponse> {
    if (!this.baseUrl) {
      return {
        ok: false,
        code: "engine_offline",
        message: "No companion base URL configured. Use Control → Companion → Show pair code.",
      };
    }
    try {
      return await this.postJson<PairResponse>(
        "/companion/v1/pair",
        {
          ...request,
          protocolVersion: request.protocolVersion ?? COMPANION_PROTOCOL_VERSION,
        },
        opts?.signal,
      );
    } catch (error) {
      return {
        ok: false,
        code: "engine_offline",
        message: humanizeNetworkError(error, this.baseUrl),
      };
    }
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

  /**
   * Open the live state SSE stream (GET /companion/v1/events).
   * Uses fetch + stream (not EventSource) so Authorization bearer works.
   * Yields parsed events until aborted or the connection ends.
   */
  async *liveEvents(signal?: AbortSignal): AsyncGenerator<
    | { type: "snapshot"; state: CompanionLiveState }
    | { type: "heartbeat"; seq: number; at: string }
    | { type: "session"; reason: string; seq?: number; at?: string }
    | { type: "tab.command"; command: CompanionTabCommand }
    | { type: "approvals.changed"; id?: string; decision?: string }
  > {
    if (!this.baseUrl || !this.sessionToken) {
      throw new Error("Not paired — cannot open live stream.");
    }
    const res = await this.fetchImpl(this.url("/companion/v1/events"), {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${this.sessionToken}`,
      },
      signal,
    });
    if (!res.ok) {
      throw new Error(`GET /companion/v1/events → ${res.status}`);
    }
    if (!res.body) {
      throw new Error("Live stream response has no body.");
    }
    for await (const frame of parseSse(res.body)) {
      if (frame.event === "snapshot") {
        yield { type: "snapshot", state: JSON.parse(frame.data) as CompanionLiveState };
      } else if (frame.event === "heartbeat") {
        const body = JSON.parse(frame.data) as { seq: number; at: string };
        yield { type: "heartbeat", seq: body.seq, at: body.at };
      } else if (frame.event === "session") {
        const body = JSON.parse(frame.data) as { reason: string; seq?: number; at?: string };
        yield { type: "session", reason: body.reason, seq: body.seq, at: body.at };
      } else if (frame.event === "tab.command") {
        yield { type: "tab.command", command: JSON.parse(frame.data) as CompanionTabCommand };
      } else if (frame.event === "approvals.changed") {
        const body = JSON.parse(frame.data) as { id?: string; decision?: string };
        yield { type: "approvals.changed", id: body.id, decision: body.decision };
      }
    }
  }

  /** Fulfill a tab.command from the engine (agent tool path). */
  async postTabResult(body: CompanionTabResult): Promise<{ ok: boolean; message?: string }> {
    if (!this.baseUrl || !this.sessionToken) {
      return { ok: false, message: "Not paired." };
    }
    return this.postJson("/companion/v1/tab/result", body);
  }

  async listPendingTabCommands(): Promise<{ ok: boolean; commands?: CompanionTabCommand[]; message?: string }> {
    if (!this.baseUrl || !this.sessionToken) {
      return { ok: false, message: "Not paired." };
    }
    return this.getJson("/companion/v1/tab/pending");
  }

  private async getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(this.url(path), {
      method: "GET",
      headers: this.headers(),
      signal: signal ?? AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`GET ${path} → ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Error(humanizeNetworkError(error, this.baseUrl));
    }
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
export type { CompanionLiveState };

/** Map fetch / abort failures into a short operator-facing message. */
export function humanizeNetworkError(error: unknown, baseUrl?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  if (lower.includes("abort") || lower.includes("timeout")) {
    return `Timed out talking to the engine${baseUrl ? ` at ${baseUrl}` : ""}. Is Tachyon running? Try Show pair code again.`;
  }
  if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower.includes("load failed")) {
    return (
      `Cannot reach the engine${baseUrl ? ` at ${baseUrl}` : ""} (network / permission). ` +
      `Check: engine is up, Base URL matches Control, and this extension may access that host. ` +
      `On WSL + Windows Chrome, 127.0.0.1 must be the port forwarded to Windows.`
    );
  }
  return raw || "Network request failed";
}

/** Minimal SSE parser for fetch ReadableStream bodies. */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let dataLines: string[] = [];

  const flush = (): { event: string; data: string } | undefined => {
    if (dataLines.length === 0) {
      event = "message";
      return undefined;
    }
    const frame = { event, data: dataLines.join("\n") };
    event = "message";
    dataLines = [];
    return frame;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.startsWith(":")) continue; // comment / keep-alive
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
          continue;
        }
        if (line === "") {
          const frame = flush();
          if (frame) yield frame;
        }
      }
    }
    const tail = flush();
    if (tail) yield tail;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
