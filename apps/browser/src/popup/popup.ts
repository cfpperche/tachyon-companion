/**
 * Popup shell — status + placeholders for pair / send tab / approvals.
 */

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function setText(id: string, text: string): void {
  $(id).textContent = text;
}

async function refresh(): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: "getStatus" });
  const status = (res?.status as string) ?? "disconnected";
  setText("status", status);
  setText("protocol", String(res?.protocolVersion ?? "—"));
  setText("version", String(res?.extensionVersion ?? "—"));
  const engine = res?.engine?.label as string | undefined;
  setText("engine", engine ?? "—");
  $("badge").dataset.status = status;
}

document.getElementById("refresh")?.addEventListener("click", () => {
  void refresh();
});

document.getElementById("reset")?.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "resetPairing" }).then(() => refresh());
});

void refresh();
