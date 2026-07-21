import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  type BadgeTone,
} from "@tachyon-companion/browser-ui";
import {
  captureTabScreenshot,
  captureTabSnapshot,
  getActiveTabMeta,
  getLiveState,
  getTrust,
  listApprovals,
  pair as pairApi,
  resolveApproval,
  runTabAction,
  sendPrompt,
  setTrust,
  subscribeLiveState,
  unpair as unpairApi,
  type AgentView,
  type ApprovalSummary,
  type ConnectionView,
  type LiveView,
} from "./chromeApi.js";

type Theme = "system" | "light" | "dark";

const THEME_KEY = "tachyonCompanion.theme";

function statusTone(status: string): BadgeTone {
  if (status === "connected") return "success";
  if (status === "pairing") return "warning";
  if (status === "error" || status === "expired") return "danger";
  return "neutral";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
}

export function App() {
  /** Paired app tabs: agents first. Unpaired uses dedicated login shell (no tabs). */
  const [tab, setTab] = useState("agents");
  const [theme, setTheme] = useState<Theme>("system");

  const [conn, setConn] = useState<ConnectionView>({ status: "disconnected" });
  const [stream, setStream] = useState<LiveView["stream"]>("idle");
  const [baseUrl, setBaseUrl] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Tab control (live content-script actions when agent tab access is on)
  const [tabUrl, setTabUrl] = useState("");
  const [tabTitle, setTabTitle] = useState("");
  const [snapshotPreview, setSnapshotPreview] = useState(
    "Capture the active tab to build a DOM outline (read-only).",
  );
  const [snapshotMeta, setSnapshotMeta] = useState<string>("");
  const [screenshotPreview, setScreenshotPreview] = useState<string>("");
  const [tabBusy, setTabBusy] = useState(false);
  const [tabError, setTabError] = useState<string | undefined>();
  const [fillSelector, setFillSelector] = useState("");
  const [fillValue, setFillValue] = useState("");
  const [agentTabRead, setAgentTabRead] = useState(false);
  const [hostAccess, setHostAccess] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalSummary[]>([]);
  const [approvalsBusy, setApprovalsBusy] = useState(false);
  const [approvalsError, setApprovalsError] = useState<string | undefined>();

  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY) as Theme | null;
    if (saved === "light" || saved === "dark" || saved === "system") {
      setTheme(saved);
      applyTheme(saved);
    } else {
      applyTheme("system");
    }
  }, []);

  const setThemePersist = (t: Theme) => {
    setTheme(t);
    localStorage.setItem(THEME_KEY, t);
    applyTheme(t);
  };

  /** Apply SW live snapshot (SSE → storage/message). No manual refresh. */
  const applyLive = (live: LiveView) => {
    setConn(live.connection);
    setStream(live.stream);
    setAgents(live.agents);
    if (live.connection.baseUrl) {
      setBaseUrl((prev) => prev || live.connection.baseUrl || "");
    }
    if (live.stream === "live") {
      setError(undefined);
      setInfo(undefined);
    } else if (live.streamError && live.stream === "error") {
      setError(live.streamError);
    } else if (live.connection.lastError) {
      setError(live.connection.lastError);
    }
    setSelectedAgent((prev) => {
      if (prev && live.agents.some((a) => a.name === prev)) return prev;
      return live.agents[0]?.name ?? "";
    });
  };

  useEffect(() => {
    let cancelled = false;
    void getLiveState()
      .then((live) => {
        if (!cancelled) applyLive(live);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    const unsub = subscribeLiveState((live) => {
      if (!cancelled) applyLive(live);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const connected = conn.status === "connected";

  // After pair → land on Agents; drop obsolete "live" tab id if still selected.
  useEffect(() => {
    if (connected) {
      setTab((t) => (t === "live" ? "agents" : t));
    }
  }, [connected]);

  // While Agents is open, re-list from engine so new spawns appear without leaving the tab.
  useEffect(() => {
    if (tab !== "agents" || !connected) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const { listAgents } = await import("./chromeApi.js");
        const res = await listAgents();
        if (cancelled || !res.ok || !res.agents) return;
        setAgents(res.agents);
        setSelectedAgent((prev) => {
          if (prev && res.agents!.some((a) => a.name === prev)) return prev;
          return res.agents![0]?.name ?? "";
        });
      } catch {
        /* ignore poll errors */
      }
    };
    void pull();
    const id = setInterval(() => void pull(), 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tab, connected]);

  const agentOptions = agents.map((a) => ({
    value: a.name,
    label: `${a.name} · ${a.attention}${a.composerOccupied ? " · composer" : ""}`,
  }));

  const onPair = async () => {
    setBusy(true);
    setError(undefined);
    setInfo(undefined);
    try {
      const res = await pairApi(baseUrl.trim(), pairCode.trim());
      if (!res?.ok) {
        setError(res?.message ?? res?.code ?? "Pair failed. Check Base URL, code, and that Tachyon is running.");
        return;
      }
      setPairCode("");
      setInfo(undefined);
      // Live stream pushes connection + agents; no manual refresh.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Always available while disconnected — clears stuck loading / errors so the user can retry. */
  const onResetPairForm = () => {
    setBusy(false);
    setError(undefined);
    setInfo(undefined);
  };

  const onUnpair = async () => {
    setBusy(true);
    setError(undefined);
    setInfo(undefined);
    try {
      await unpairApi();
      setInfo("Unpaired.");
      setAgents([]);
      setConn({ status: "disconnected" });
      setStream("idle");
    } finally {
      setBusy(false);
    }
  };

  const refreshActiveTabMeta = async () => {
    try {
      const m = await getActiveTabMeta();
      if (m.ok) {
        if (m.url) setTabUrl(m.url);
        if (m.title) setTabTitle(m.title);
      }
    } catch {
      /* ignore */
    }
  };

  const onCaptureSnapshot = async () => {
    setTabBusy(true);
    setTabError(undefined);
    try {
      const res = await captureTabSnapshot();
      if (!res.ok) {
        setTabError(res.message ?? res.code ?? "Snapshot failed");
        return;
      }
      setTabUrl(res.url);
      setTabTitle(res.title);
      setSnapshotPreview(res.outline);
      setSnapshotMeta(
        `${res.stats.nodes} nodes · ${res.stats.outlineChars} chars` +
          (res.stats.truncated ? " · truncated" : "") +
          (res.selection ? ` · selection ${res.selection.length}c` : ""),
      );
    } catch (e) {
      setTabError(e instanceof Error ? e.message : String(e));
    } finally {
      setTabBusy(false);
    }
  };

  const onCaptureScreenshot = async () => {
    setTabBusy(true);
    setTabError(undefined);
    try {
      const res = await captureTabScreenshot({ format: "jpeg", quality: 70 });
      if (!res.ok) {
        setTabError(res.message ?? res.code ?? "Screenshot failed");
        return;
      }
      setTabUrl(res.url);
      setTabTitle(res.title);
      setScreenshotPreview(res.dataUrl);
      setInfo(`Screenshot ${(res.byteLength / 1024).toFixed(0)} KB · first-person tab view`);
    } catch (e) {
      setTabError(e instanceof Error ? e.message : String(e));
    } finally {
      setTabBusy(false);
    }
  };

  useEffect(() => {
    if (tab === "tab") void refreshActiveTabMeta();
  }, [tab]);

  const refreshApprovals = async () => {
    // Always hit the SW/engine when asked — do not gate on React `connected`
    // (stale closure used to skip updates after SSE pushes).
    try {
      const res = await listApprovals();
      if (res.ok) {
        setApprovals(res.approvals);
        setApprovalsError(undefined);
      } else if (res.code === "unpaired") {
        setApprovals([]);
      } else {
        setApprovalsError(res.message ?? "Could not load approvals");
      }
    } catch (e) {
      setApprovalsError(e instanceof Error ? e.message : String(e));
    }
  };

  // Load + light poll while Approvals is open (SSE may lag or engine may miss push).
  useEffect(() => {
    if (tab !== "approvals" || !connected) return;
    setApprovalsError(undefined);
    void refreshApprovals();
    const poll = setInterval(() => void refreshApprovals(), 2000);
    return () => clearInterval(poll);
  }, [tab, connected]);

  // Push path: SW gets SSE approvals.changed → storage tick + message.
  useEffect(() => {
    const onMsg = (message: { type?: string }) => {
      if (message?.type === "approvalsChanged") void refreshApprovals();
    };
    const onStorage = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local" && changes["tachyonCompanion.approvals.tick"]) {
        void refreshApprovals();
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    chrome.storage.onChanged.addListener(onStorage);
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, []);

  const onResolveApproval = async (id: string, decision: "approved" | "denied") => {
    setApprovalsBusy(true);
    setApprovalsError(undefined);
    try {
      const res = await resolveApproval(id, decision);
      if (!res.ok) {
        setApprovalsError(res.message ?? "Resolve failed");
        return;
      }
      setInfo(`${decision === "approved" ? "Approved" : "Denied"} ${id}`);
      await refreshApprovals();
    } catch (e) {
      setApprovalsError(e instanceof Error ? e.message : String(e));
    } finally {
      setApprovalsBusy(false);
    }
  };

  useEffect(() => {
    void getTrust()
      .then((t) => {
        if (t.ok && t.policy) {
          setAgentTabRead(t.policy.agentTabRead === "on");
          setHostAccess(!!t.hostAccess);
        }
      })
      .catch(() => {});
  }, []);

  const onToggleAgentTabRead = async (on: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await setTrust(on ? "on" : "off");
      if (!res.ok) {
        setError(res.message ?? "Could not update trust");
        setAgentTabRead(false);
        return;
      }
      setAgentTabRead(res.policy?.agentTabRead === "on");
      setHostAccess(!!res.hostAccess);
      setInfo(
        on
          ? "Agent tab reads on — engine tools may request DOM snapshots."
          : "Agent tab reads off.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAgentTabRead(false);
    } finally {
      setBusy(false);
    }
  };

  const onSend = async () => {
    setBusy(true);
    setError(undefined);
    setInfo(undefined);
    if (!selectedAgent) {
      setError("Pick an active agent.");
      setBusy(false);
      return;
    }
    if (!connected) {
      setError("Not connected.");
      setBusy(false);
      return;
    }
    try {
      const res = await sendPrompt(selectedAgent, message);
      if (!res.ok) {
        setError(res.message ?? res.code ?? "send failed");
        return;
      }
      setInfo(`OK → ${res.agent}: ${res.status === "queued" ? "queued until idle" : "sent now"}`);
      setMessage("");
      // Attention / agent rows update via live stream.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const syncLabel =
    stream === "live"
      ? "live"
      : stream === "connecting" || stream === "reconnecting"
        ? stream
        : stream === "error"
          ? "sync error"
          : stream === "idle"
            ? connected
              ? "starting…"
              : "—"
            : stream;

  const panelPad = "flex flex-col gap-3 px-3.5 py-3";

  // —— Unpaired: login / pair only (no bottom tabs) ——
  if (!connected) {
    return (
      <div
        className="flex h-full min-h-screen flex-col bg-[var(--tc-bg)] text-[var(--tc-text)]"
        data-testid="companion-login"
      >
        <div className={`${panelPad} flex-1`}>
          <div className="mb-1">
            <h1 className="m-0 text-[15px] font-semibold tracking-tight text-[var(--tc-text)]">Sign in</h1>
            <p className="m-0 mt-1 text-[var(--tc-text-xs)] text-[var(--tc-text-muted)]">
              Pair this browser with a local Tachyon engine. In Control: Show pair code.
            </p>
          </div>

          {(error || info) && (
            <div className="space-y-1">
              {error ? (
                <p className="m-0 text-[var(--tc-text-sm)] text-[var(--tc-danger)]" data-testid="pair-error">
                  {error}
                </p>
              ) : null}
              {info ? <p className="m-0 text-[var(--tc-text-sm)] text-[var(--tc-success)]">{info}</p> : null}
            </div>
          )}

          <Card title="Pair with engine" hint="Command: Tachyon: Pair Companion (show code)">
            <Field label="Base URL">
              <Input
                value={baseUrl}
                onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
                placeholder="http://127.0.0.1:41xxx"
                disabled={busy}
              />
            </Field>
            <Field label="Pair code">
              <Input
                value={pairCode}
                onInput={(e) => setPairCode((e.target as HTMLInputElement).value)}
                placeholder="XXXXXXXX"
                maxLength={16}
                spellcheck={false}
                disabled={busy}
              />
            </Field>
            {busy ? (
              <p className="m-0 mb-2 text-[var(--tc-text-xs)] text-[var(--tc-text-muted)]">Pairing…</p>
            ) : null}
            <div className="flex flex-col gap-2">
              <Button
                className="w-full"
                disabled={busy || !baseUrl.trim() || !pairCode.trim()}
                onClick={() => void onPair()}
              >
                {busy ? "Pairing…" : "Pair"}
              </Button>
              <Button
                variant="secondary"
                className="w-full"
                data-testid="pair-reset"
                onClick={onResetPairForm}
                disabled={!busy && !error}
              >
                {busy ? "Cancel" : "Clear error / retry"}
              </Button>
            </div>
          </Card>

          <div className="mt-auto flex flex-col items-center gap-2 pt-4">
            <ThemeSegment theme={theme} onChange={setThemePersist} />
            <p className="m-0 text-center text-[10px] text-[var(--tc-text-muted)]">
              {conn.status === "disconnected" ? "Unpaired" : conn.status}
              {baseUrl || conn.baseUrl ? ` · ${(conn.baseUrl ?? baseUrl).replace(/^https?:\/\//, "")}` : ""}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // —— Paired: tabs (Agents first; Connection lives under Settings) ——
  return (
    <div className="flex h-full min-h-screen flex-col bg-[var(--tc-bg)] text-[var(--tc-text)]">
      <Tabs value={tab} onValueChange={setTab}>
        {/* —— AGENTS (default home) —— */}
        <TabsContent value="agents" className={panelPad}>
          {(error || info) && tab === "agents" ? (
            <div className="space-y-1">
              {error ? <p className="m-0 text-[var(--tc-text-sm)] text-[var(--tc-danger)]">{error}</p> : null}
              {info ? <p className="m-0 text-[var(--tc-text-sm)] text-[var(--tc-success)]">{info}</p> : null}
            </div>
          ) : null}

          <Card
            title="Message agent"
            hint="Running agents only. Working → queued until idle. Pick an agent in the dropdown."
            footer={
              <Button className="w-full" disabled={busy} onClick={() => void onSend()}>
                Send
              </Button>
            }
          >
            <Field label="Active agent">
              <Select
                value={selectedAgent}
                onValueChange={setSelectedAgent}
                options={agentOptions.length ? agentOptions : [{ value: "", label: "No active agents" }]}
                placeholder="Select agent"
              />
            </Field>
            <Field label="Message">
              <Textarea
                value={message}
                onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)}
                placeholder="What should the agent do?"
                maxLength={2000}
              />
            </Field>
          </Card>
        </TabsContent>

        {/* —— TAB: live DOM read + future actions —— */}
        <TabsContent value="tab" className={panelPad}>
          {tabError ? (
            <p className="m-0 text-[var(--tc-text-sm)] text-[var(--tc-danger)]">{tabError}</p>
          ) : null}

          <Card
            title="Active tab"
            hint="First-person view of the focused browser tab (no cookies)"
            footer={
              <div className="flex w-full flex-col gap-2">
                <Button className="w-full" disabled={tabBusy} onClick={() => void onCaptureScreenshot()}>
                  {tabBusy ? "Capturing…" : "Capture screenshot"}
                </Button>
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={tabBusy}
                  onClick={() => void onCaptureSnapshot()}
                >
                  Capture DOM outline
                </Button>
              </div>
            }
          >
            <dl className="m-0 mb-2 grid gap-2 text-[var(--tc-text-sm)]">
              <Row k="Title" v={tabTitle || "—"} />
              <Row k="URL" v={tabUrl || "—"} mono />
            </dl>
            <div className="flex flex-wrap gap-2">
              <Badge tone="success" dot>
                screenshot
              </Badge>
              <Badge tone="info" dot>
                DOM · act · eval
              </Badge>
            </div>
            {screenshotPreview ? (
              <img
                src={screenshotPreview}
                alt="Active tab screenshot"
                className="mt-2 max-h-48 w-full rounded-[var(--tc-radius-sm)] border border-[var(--tc-border)] object-contain object-top"
              />
            ) : null}
          </Card>

          <Card
            title="DOM snapshot"
            hint={snapshotMeta || "Capped outline for agents · passwords redacted"}
          >
            <pre className="m-0 max-h-56 overflow-auto rounded-[var(--tc-radius-sm)] bg-[var(--tc-bg-muted)] p-2 font-mono text-[10px] text-[var(--tc-text-muted)] whitespace-pre-wrap">
              {snapshotPreview}
            </pre>
            <Button
              variant="ghost"
              className="mt-2 w-full"
              disabled={tabBusy}
              onClick={() => void onCaptureSnapshot()}
            >
              Refresh snapshot
            </Button>
          </Card>

          <Card
            title="Page actions"
            hint="Live content-script click · fill (agent tools: user_browser_click / fill / type)"
          >
            <Field label="Selector">
              <Input
                value={fillSelector}
                onInput={(e) => setFillSelector((e.target as HTMLInputElement).value)}
                placeholder="button.submit, #email, …"
              />
            </Field>
            <Field label="Value (for fill)">
              <Input
                value={fillValue}
                onInput={(e) => setFillValue((e.target as HTMLInputElement).value)}
                placeholder="text to fill"
              />
            </Field>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                disabled={tabBusy || !fillSelector.trim()}
                onClick={() =>
                  void (async () => {
                    setTabBusy(true);
                    setTabError(undefined);
                    try {
                      const res = await runTabAction({ kind: "click", selector: fillSelector.trim() });
                      if (!res.ok) setTabError(res.message);
                      else setInfo(res.detail ?? "Clicked.");
                    } catch (e) {
                      setTabError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setTabBusy(false);
                    }
                  })()
                }
              >
                Click
              </Button>
              <Button
                className="flex-1"
                disabled={tabBusy || !fillSelector.trim()}
                onClick={() =>
                  void (async () => {
                    setTabBusy(true);
                    setTabError(undefined);
                    try {
                      const res = await runTabAction({
                        kind: "fill",
                        selector: fillSelector.trim(),
                        value: fillValue,
                      });
                      if (!res.ok) setTabError(res.message);
                      else setInfo(res.detail ?? "Filled.");
                    } catch (e) {
                      setTabError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setTabBusy(false);
                    }
                  })()
                }
              >
                Fill
              </Button>
            </div>
          </Card>

        </TabsContent>

        {/* —— APPROVALS —— */}
        <TabsContent value="approvals" className={panelPad}>
          {approvalsError ? (
            <p className="m-0 text-[var(--tc-text-sm)] text-[var(--tc-danger)]">{approvalsError}</p>
          ) : null}
          {(error || info) && tab === "approvals" ? (
            <div className="space-y-1">
              {error ? <p className="m-0 text-[var(--tc-text-sm)] text-[var(--tc-danger)]">{error}</p> : null}
              {info ? <p className="m-0 text-[var(--tc-text-sm)] text-[var(--tc-success)]">{info}</p> : null}
            </div>
          ) : null}

          <Card
            title="Pending approvals"
            hint="Host-authoritative Accept / Deny · same ledger as Control"
            footer={
              <Button
                variant="ghost"
                className="w-full"
                disabled={approvalsBusy}
                onClick={() => void refreshApprovals()}
              >
                Refresh
              </Button>
            }
          >
            <div className="flex flex-col gap-2">
              {approvals.map((a) => (
                <div
                  key={a.id}
                  className="rounded-[var(--tc-radius-sm)] border border-[var(--tc-border)] bg-[var(--tc-bg-muted)] p-2.5"
                >
                  <div className="text-[var(--tc-text-sm)] font-semibold text-[var(--tc-text)]">{a.reason}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--tc-text-muted)]">
                    <span className="font-mono">{a.id}</span>
                    {a.requester ? <span>{a.requester}</span> : null}
                    <Badge tone="warning">{a.risk}</Badge>
                  </div>
                  <p className="m-0 mt-1.5 text-[var(--tc-text-xs)] text-[var(--tc-text-muted)]">
                    Action: {a.proposedAction}
                  </p>
                  {a.exactPrompt ? (
                    <pre className="m-0 mt-1.5 max-h-24 overflow-auto rounded-[var(--tc-radius-sm)] bg-[var(--tc-bg)] p-2 font-mono text-[10px] text-[var(--tc-text-muted)] whitespace-pre-wrap">
                      {a.exactPrompt}
                    </pre>
                  ) : null}
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="flex-1"
                      disabled={approvalsBusy}
                      onClick={() => void onResolveApproval(a.id, "denied")}
                    >
                      Deny
                    </Button>
                    <Button
                      size="sm"
                      className="flex-1"
                      disabled={approvalsBusy}
                      onClick={() => void onResolveApproval(a.id, "approved")}
                    >
                      Accept
                    </Button>
                  </div>
                </div>
              ))}
              {approvals.length === 0 ? (
                <p className="m-0 text-[var(--tc-text-xs)] text-[var(--tc-text-muted)]">No pending approvals.</p>
              ) : null}
            </div>
          </Card>
        </TabsContent>

        {/* —— AUDIT —— */}
        <TabsContent value="audit" className={panelPad}>
          <Card title="Activity" hint="Local log of Companion actions on this machine (coming soon)">
            <p className="m-0 text-[var(--tc-text-sm)] text-[var(--tc-text-muted)]">
              No activity recorded yet. Pair, messages, and tab actions will show up here when the
              local audit trail is wired.
            </p>
          </Card>
        </TabsContent>

        {/* —— SETTINGS: connection + theme + trust —— */}
        <TabsContent value="settings" className={panelPad}>
          {(error || info) && tab === "settings" ? (
            <div className="space-y-1">
              {error ? <p className="m-0 text-[var(--tc-text-sm)] text-[var(--tc-danger)]">{error}</p> : null}
              {info ? <p className="m-0 text-[var(--tc-text-sm)] text-[var(--tc-success)]">{info}</p> : null}
            </div>
          ) : null}

          <Card
            title="Connection"
            hint={
              stream === "live"
                ? "Live sync on"
                : stream === "connecting" || stream === "reconnecting"
                  ? `Sync ${stream}…`
                  : stream === "error"
                    ? "Sync error — retrying"
                    : undefined
            }
            footer={
              <Button variant="danger" className="w-full" disabled={busy} onClick={() => void onUnpair()}>
                Unpair
              </Button>
            }
          >
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <span className="text-[var(--tc-text-xs)] text-[var(--tc-text-muted)]">Status</span>
              <Badge tone={statusTone(conn.status)} dot>
                {conn.status}
              </Badge>
            </div>
            <dl className="m-0 grid gap-2 text-[var(--tc-text-sm)]">
              <Row k="Engine" v={conn.engine?.label ?? "—"} />
              <Row k="Base URL" v={(conn.baseUrl ?? baseUrl) || "—"} mono />
              <Row k="Protocol" v={String(conn.protocolVersion ?? "—")} />
              <Row k="Extension" v={conn.extensionVersion ?? "—"} />
              <Row k="Sync" v={syncLabel} />
            </dl>
          </Card>

          <Card title="Appearance">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[var(--tc-text-sm)] text-[var(--tc-text-muted)]">Theme</span>
              <ThemeSegment theme={theme} onChange={setThemePersist} />
            </div>
          </Card>

          <Card title="Agent tab access" hint="Trust — t-e05d2d · enables user_browser_snapshot">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[var(--tc-text-sm)] font-semibold">Allow agent tab reads</div>
                <p className="m-0 text-[10px] text-[var(--tc-text-muted)]">
                  When on, the agent may read/act/screenshot your active tab (no cookies; passwords redacted).
                  Chrome will ask for access on all sites — required for screenshots (`captureVisibleTab`).
                </p>
                <p className="m-0 mt-1 text-[10px] text-[var(--tc-text-muted)]">
                  Host access (&lt;all_urls&gt;): {hostAccess ? "granted" : "not granted"}
                </p>
              </div>
              <Switch
                checked={agentTabRead}
                disabled={busy}
                onCheckedChange={(v) => void onToggleAgentTabRead(v)}
              />
            </div>
          </Card>
        </TabsContent>

        {/* Mobile bottom nav — Agents first; no Connection tab */}
        <TabsList>
          <TabsTrigger value="agents" icon={<IconUsers />} hint="Agents" />
          <TabsTrigger value="tab" icon={<IconWindow />} hint="Tab" />
          <TabsTrigger value="approvals" icon={<IconShield />} hint="Approvals" />
          <TabsTrigger value="audit" icon={<IconList />} hint="Audit" />
          <TabsTrigger value="settings" icon={<IconGear />} hint="Settings" />
        </TabsList>
      </Tabs>
    </div>
  );
}

/** Compact icon-only theme radios (system / light / dark) — no text labels. */
function ThemeSegment({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (t: Theme) => void;
}) {
  const items: { id: Theme; hint: string; icon: ComponentChildren }[] = [
    { id: "system", hint: "System", icon: <IconMonitor /> },
    { id: "light", hint: "Light", icon: <IconSun /> },
    { id: "dark", hint: "Dark", icon: <IconMoon /> },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex rounded-full border border-[var(--tc-border)] bg-[var(--tc-bg-muted)] p-0.5"
      data-testid="theme-segment"
    >
      {items.map((item) => {
        const active = theme === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={item.hint}
            title={item.hint}
            onClick={() => onChange(item.id)}
            className={
              "flex h-8 w-8 items-center justify-center rounded-full transition-colors " +
              (active
                ? "bg-[var(--tc-bg-elevated)] text-[var(--tc-accent)] shadow-sm"
                : "text-[var(--tc-text-muted)] hover:text-[var(--tc-text)]")
            }
          >
            <span className="flex h-4 w-4 items-center justify-center [&_svg]:h-4 [&_svg]:w-4" aria-hidden>
              {item.icon}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-2">
      <dt className="m-0 text-[var(--tc-text-muted)]">{k}</dt>
      <dd className={"m-0 truncate " + (mono ? "font-mono text-[11px]" : "font-medium")}>{v}</dd>
    </div>
  );
}

function iconProps(children: ComponentChildren) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function IconUsers() {
  return iconProps(
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>,
  );
}

function IconWindow() {
  return iconProps(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
    </>,
  );
}

function IconShield() {
  return iconProps(
    <>
      <path d="M12 3 4 7v5c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V7l-8-4z" />
    </>,
  );
}

function IconList() {
  return iconProps(
    <>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </>,
  );
}

/** Classic cog / gear (settings), not the old ray/sun mark. */
function IconGear() {
  return iconProps(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
  );
}

function IconMonitor() {
  return iconProps(
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>,
  );
}

function IconSun() {
  return iconProps(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </>,
  );
}

function IconMoon() {
  return iconProps(
    <>
      <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 0 0 11.5 11.5z" />
    </>,
  );
}
