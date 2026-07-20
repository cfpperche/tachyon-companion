function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function setText(id: string, text: string): void {
  $(id).textContent = text;
}

function showError(msg: string | undefined): void {
  const el = $("error");
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

function showInfo(msg: string | undefined): void {
  const el = $("info");
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

async function refresh(): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: "getStatus" });
  const status = (res?.status as string) ?? "disconnected";
  setText("status", status);
  setText("protocol", String(res?.protocolVersion ?? "—"));
  setText("version", String(res?.extensionVersion ?? "—"));
  setText("engine", (res?.engine?.label as string | undefined) ?? "—");
  setText("baseUrl", (res?.baseUrl as string | undefined) ?? "—");
  $("badge").dataset.status = status;
  if (res?.lastError) showError(String(res.lastError));
  else showError(undefined);

  const baseInput = document.getElementById("inputBase") as HTMLInputElement | null;
  if (baseInput && res?.baseUrl && !baseInput.value) baseInput.value = String(res.baseUrl);

  const connected = status === "connected";
  $("prompt-form").hidden = !connected;
  $("pair-form").hidden = connected;
  if (connected) await refreshAgents();
}

async function refreshAgents(): Promise<void> {
  const select = document.getElementById("agentSelect") as HTMLSelectElement;
  const prev = select.value;
  const res = await chrome.runtime.sendMessage({ type: "listAgents" });
  select.innerHTML = "";
  if (!res?.ok || !Array.isArray(res.agents) || res.agents.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = res?.message ? String(res.message) : "No active agents";
    select.appendChild(opt);
    return;
  }
  for (const a of res.agents as Array<{ name: string; attention?: string; composerOccupied?: boolean }>) {
    const opt = document.createElement("option");
    opt.value = a.name;
    const busy = a.composerOccupied ? " · composer" : "";
    opt.textContent = `${a.name} · ${a.attention ?? "?"}${busy}`;
    select.appendChild(opt);
  }
  if (prev && Array.from(select.options).some((o) => o.value === prev)) select.value = prev;
}

document.getElementById("refresh")?.addEventListener("click", () => {
  void refresh();
});

document.getElementById("reset")?.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "unpair" }).then(() => refresh());
});

document.getElementById("pair")?.addEventListener("click", () => {
  void (async () => {
    showError(undefined);
    showInfo(undefined);
    const baseUrl = (document.getElementById("inputBase") as HTMLInputElement).value.trim();
    const pairCode = (document.getElementById("inputCode") as HTMLInputElement).value.trim();
    const res = await chrome.runtime.sendMessage({ type: "pair", baseUrl, pairCode });
    if (!res?.ok) {
      showError(String(res?.message ?? res?.code ?? "pair failed"));
      return;
    }
    (document.getElementById("inputCode") as HTMLInputElement).value = "";
    await refresh();
  })();
});

document.getElementById("refreshAgents")?.addEventListener("click", () => {
  void refreshAgents();
});

document.getElementById("sendPrompt")?.addEventListener("click", () => {
  void (async () => {
    showError(undefined);
    showInfo(undefined);
    const agent = (document.getElementById("agentSelect") as HTMLSelectElement).value;
    const text = (document.getElementById("promptText") as HTMLTextAreaElement).value;
    if (!agent) {
      showError("Pick an active agent.");
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: "sendPrompt", agent, text });
    if (!res?.ok) {
      showError(String(res?.message ?? res?.code ?? "send failed"));
      return;
    }
    const status = res.status === "queued" ? "queued until idle" : "sent now";
    showInfo(`OK → ${res.agent}: ${status}`);
    (document.getElementById("promptText") as HTMLTextAreaElement).value = "";
    await refreshAgents();
  })();
});

void refresh();
