import { useEffect, useMemo, useState } from "preact/hooks";
import {
  AgentRow,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  StatusHeader,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  type BadgeTone,
} from "@tachyon-companion/browser-ui";
import {
  getLiveState,
  pair as pairApi,
  sendPrompt,
  subscribeLiveState,
  unpair as unpairApi,
  type AgentView,
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

/** Prototype-only fixtures for “product complete” illustrations. */
const PROTO_AGENTS: AgentView[] = [
  { name: "grok", attention: "idle", composerOccupied: false },
  { name: "codex", attention: "working", composerOccupied: true },
  { name: "claude", attention: "needs-input", composerOccupied: false },
];

const PROTO_AUDIT = [
  { t: "14:02", kind: "prompt", text: "→ grok: review the open PR comments" },
  { t: "14:01", kind: "tab", text: "snapshot x.com/home (12.4k chars)" },
  { t: "13:58", kind: "action", text: "click [data-testid=login] — ok" },
  { t: "13:55", kind: "pair", text: "paired workspace @ 127.0.0.1:41179" },
];

const PROTO_APPROVALS = [
  {
    id: "a-1",
    title: "Allow write to src/bridge/tools.ts",
    risk: "medium",
    agent: "codex",
  },
  {
    id: "a-2",
    title: "Run npm run verify:full:quiet",
    risk: "low",
    agent: "grok",
  },
];

export function App() {
  const [tab, setTab] = useState("live");
  const [theme, setTheme] = useState<Theme>("system");
  const [protoMode, setProtoMode] = useState(true);

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

  // Future-feature prototype local state (UI only)
  const [tabUrl, setTabUrl] = useState("https://example.com/app");
  const [snapshotPreview, setSnapshotPreview] = useState(
    "html > body > main\n  h1 \"Checkout\"\n  form#pay\n    input[name=email]\n    button[type=submit] \"Pay\"",
  );
  const [fillSelector, setFillSelector] = useState("input[name=email]");
  const [fillValue, setFillValue] = useState("user@example.com");

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
  const displayAgents = useMemo(() => {
    if (agents.length > 0) return agents;
    if (protoMode && !connected) return PROTO_AGENTS;
    return [];
  }, [agents, protoMode, connected]);

  const agentOptions = displayAgents.map((a) => ({
    value: a.name,
    label: `${a.name} · ${a.attention}${a.composerOccupied ? " · composer" : ""}`,
  }));

  const onPair = async () => {
    setBusy(true);
    setError(undefined);
    setInfo(undefined);
    try {
      const res = await pairApi(baseUrl.trim(), pairCode.trim());
      if (!res.ok) {
        setError(res.message ?? res.code ?? "pair failed");
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
      setError(protoMode ? "Prototype: connect (Pair) to send for real." : "Not connected.");
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

  const streamLabel =
    stream === "live"
      ? "live"
      : stream === "connecting" || stream === "reconnecting"
        ? stream
        : stream === "error"
          ? "sync error"
          : undefined;

  return (
    <div className="flex h-full min-h-screen flex-col bg-[var(--tc-bg)] text-[var(--tc-text)]">
      <StatusHeader
        title="Tachyon Companion"
        subtitle={
          streamLabel
            ? `Local engine · ${streamLabel}`
            : "Local engine · side panel"
        }
        statusLabel={conn.status}
        statusTone={statusTone(conn.status)}
      />

      <div className="flex flex-1 flex-col gap-3 overflow-auto px-3.5 py-3">
        {(error || info) && (
          <div className="space-y-1">
            {error ? <p className="m-0 text-[var(--tc-text-sm)] text-[var(--tc-danger)]">{error}</p> : null}
            {info ? <p className="m-0 text-[var(--tc-text-sm)] text-[var(--tc-success)]">{info}</p> : null}
          </div>
        )}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="live">Live</TabsTrigger>
            <TabsTrigger value="tab">Tab</TabsTrigger>
            <TabsTrigger value="approvals">Approvals</TabsTrigger>
            <TabsTrigger value="audit">Audit</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          {/* —— LIVE: pair + message (working today) —— */}
          <TabsContent value="live" className="flex flex-col gap-3">
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
                connected ? (
                  <Button variant="danger" className="w-full" disabled={busy} onClick={() => void onUnpair()}>
                    Unpair
                  </Button>
                ) : undefined
              }
            >
              <dl className="m-0 grid gap-2 text-[var(--tc-text-sm)]">
                <Row k="Engine" v={conn.engine?.label ?? "—"} />
                <Row k="Base URL" v={(conn.baseUrl ?? baseUrl) || "—"} mono />
                <Row k="Protocol" v={String(conn.protocolVersion ?? "—")} />
                <Row k="Extension" v={conn.extensionVersion ?? "—"} />
                <Row
                  k="Sync"
                  v={
                    stream === "live"
                      ? "live"
                      : stream === "idle"
                        ? connected
                          ? "starting…"
                          : "—"
                        : stream
                  }
                />
              </dl>
            </Card>

            {!connected ? (
              <Card title="Pair with engine" hint="Command: Tachyon: Pair Companion (show code)">
                <Field label="Base URL">
                  <Input
                    value={baseUrl}
                    onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
                    placeholder="http://127.0.0.1:41xxx"
                  />
                </Field>
                <Field label="Pair code">
                  <Input
                    value={pairCode}
                    onInput={(e) => setPairCode((e.target as HTMLInputElement).value)}
                    placeholder="XXXXXXXX"
                    maxLength={16}
                    spellcheck={false}
                  />
                </Field>
                <Button className="w-full" disabled={busy} onClick={() => void onPair()}>
                  Pair
                </Button>
              </Card>
            ) : (
              <Card
                title="Message agent"
                hint="Running agents only. Working → queued until idle. List updates live."
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
                <div className="mb-2.5 flex flex-col gap-1.5">
                  {displayAgents.map((a) => (
                    <AgentRow
                      key={a.name}
                      name={a.name}
                      attention={a.attention}
                      composerOccupied={a.composerOccupied}
                      selected={selectedAgent === a.name}
                      onSelect={() => setSelectedAgent(a.name)}
                    />
                  ))}
                </div>
                <Field label="Message">
                  <Textarea
                    value={message}
                    onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)}
                    placeholder="What should the agent do?"
                    maxLength={2000}
                  />
                </Field>
              </Card>
            )}
          </TabsContent>

          {/* —— TAB: product vision (read + act) —— */}
          <TabsContent value="tab" className="flex flex-col gap-3">
            <Card
              title="Active tab"
              hint={protoMode ? "Prototype UI — control path not live yet" : "Tab tools"}
            >
              <Field label="URL">
                <Input value={tabUrl} onInput={(e) => setTabUrl((e.target as HTMLInputElement).value)} />
              </Field>
              <div className="mb-2 flex flex-wrap gap-2">
                <Badge tone="info" dot>
                  readable
                </Badge>
                <Badge tone="working" dot>
                  actions planned
                </Badge>
              </div>
              <Button
                variant="secondary"
                className="w-full"
                onClick={() =>
                  setInfo(protoMode ? "Prototype: would capture DOM snapshot of active tab." : "Snapshot requested.")
                }
              >
                Capture DOM snapshot
              </Button>
            </Card>

            <Card title="DOM snapshot" hint="Capped structured tree for the agent">
              <pre className="m-0 max-h-40 overflow-auto rounded-[var(--tc-radius-sm)] bg-[var(--tc-bg-muted)] p-2 font-mono text-[10px] text-[var(--tc-text-muted)] whitespace-pre-wrap">
                {snapshotPreview}
              </pre>
              <Button
                variant="ghost"
                className="mt-2 w-full"
                onClick={() =>
                  setSnapshotPreview((s) => s + "\n  /* refreshed */")
                }
              >
                Refresh snapshot
              </Button>
            </Card>

            <Card title="Page actions" hint="click · type · fill (content script)">
              <Field label="Selector / ref">
                <Input value={fillSelector} onInput={(e) => setFillSelector((e.target as HTMLInputElement).value)} />
              </Field>
              <Field label="Value">
                <Input value={fillValue} onInput={(e) => setFillValue((e.target as HTMLInputElement).value)} />
              </Field>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={() => setInfo(`Prototype: click ${fillSelector}`)}
                >
                  Click
                </Button>
                <Button
                  className="flex-1"
                  onClick={() => setInfo(`Prototype: fill ${fillSelector} = ${fillValue}`)}
                >
                  Fill
                </Button>
              </div>
            </Card>

            <Card title="Console" hint="Escalation — logs / MAIN world later">
              <p className="m-0 mb-2 text-[var(--tc-text-xs)] text-[var(--tc-text-muted)]">
                Capture page console and limited MAIN-world access when DOM alone is not enough.
              </p>
              <Button variant="ghost" className="w-full" onClick={() => setInfo("Prototype: console stream UI")}>
                Show console stream
              </Button>
            </Card>
          </TabsContent>

          {/* —— APPROVALS —— */}
          <TabsContent value="approvals" className="flex flex-col gap-3">
            <Card title="Pending approvals" hint="Host-authoritative Accept / Deny">
              <div className="flex flex-col gap-2">
                {(protoMode ? PROTO_APPROVALS : []).map((a) => (
                  <div
                    key={a.id}
                    className="rounded-[var(--tc-radius-sm)] border border-[var(--tc-border)] bg-[var(--tc-bg-muted)] p-2.5"
                  >
                    <div className="text-[var(--tc-text-sm)] font-semibold text-[var(--tc-text)]">{a.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--tc-text-muted)]">
                      <span>{a.agent}</span>
                      <Badge tone={a.risk === "medium" ? "warning" : "info"}>{a.risk}</Badge>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="flex-1"
                        onClick={() => setInfo(`Prototype: denied ${a.id}`)}
                      >
                        Deny
                      </Button>
                      <Button size="sm" className="flex-1" onClick={() => setInfo(`Prototype: approved ${a.id}`)}>
                        Accept
                      </Button>
                    </div>
                  </div>
                ))}
                {!protoMode ? (
                  <p className="m-0 text-[var(--tc-text-xs)] text-[var(--tc-text-muted)]">No pending approvals.</p>
                ) : null}
              </div>
            </Card>
          </TabsContent>

          {/* —— AUDIT —— */}
          <TabsContent value="audit" className="flex flex-col gap-3">
            <Card title="Activity" hint="What Companion did on this machine">
              <ul className="m-0 list-none space-y-2 p-0">
                {(protoMode ? PROTO_AUDIT : [{ t: "—", kind: "info", text: "No events yet" }]).map((e, i) => (
                  <li
                    key={i}
                    className="flex gap-2 border-b border-[var(--tc-border)] pb-2 last:border-0 last:pb-0"
                  >
                    <span className="w-10 shrink-0 font-mono text-[10px] text-[var(--tc-text-muted)]">{e.t}</span>
                    <div className="min-w-0">
                      <Badge tone={e.kind === "action" ? "working" : e.kind === "pair" ? "success" : "neutral"}>
                        {e.kind}
                      </Badge>
                      <p className="m-0 mt-1 text-[var(--tc-text-xs)] text-[var(--tc-text)]">{e.text}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </TabsContent>

          {/* —— SETTINGS —— */}
          <TabsContent value="settings" className="flex flex-col gap-3">
            <Card title="Theme">
              <div className="flex flex-col gap-2">
                {(["system", "light", "dark"] as Theme[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setThemePersist(t)}
                    className={
                      "flex items-center justify-between rounded-[var(--tc-radius-sm)] border px-3 py-2 text-left text-[var(--tc-text-sm)] " +
                      (theme === t
                        ? "border-[var(--tc-accent)] bg-[var(--tc-bg-muted)] font-semibold"
                        : "border-[var(--tc-border)] bg-transparent text-[var(--tc-text-muted)]")
                    }
                  >
                    <span className="capitalize">{t}</span>
                    {theme === t ? <Badge tone="info">active</Badge> : null}
                  </button>
                ))}
              </div>
            </Card>

            <Card title="Prototype mode" hint="Illustrates future product surfaces with sample data">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[var(--tc-text-sm)] font-semibold">Show vision UI</div>
                  <p className="m-0 text-[10px] text-[var(--tc-text-muted)]">
                    When on, Tab / Approvals / Audit use sample data. Live pair + prompt stay real when connected.
                  </p>
                </div>
                <Switch checked={protoMode} onCheckedChange={setProtoMode} />
              </div>
            </Card>

            <Card title="Design system">
              <p className="m-0 mb-2 text-[var(--tc-text-xs)] text-[var(--tc-text-muted)]">
                Stack: Preact · Tailwind · Radix · <code className="text-[var(--tc-text)]">@tachyon-companion/browser-ui</code>{" "}
                (own components, no shadcn). Tokens support light / dark / system.
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Badge tone="success" dot>
                  success
                </Badge>
                <Badge tone="working" dot>
                  working
                </Badge>
                <Badge tone="warning" dot>
                  warning
                </Badge>
                <Badge tone="danger" dot>
                  danger
                </Badge>
                <Badge tone="info" dot>
                  info
                </Badge>
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

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
