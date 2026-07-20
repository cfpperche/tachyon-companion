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

void refresh();
