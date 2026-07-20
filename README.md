# Tachyon Companion

**External shells** for [Tachyon](https://github.com/cfpperche/tachyon) — pair your everyday browser (and later mobile) with a local Tachyon engine.

| App | Status |
|---|---|
| **Browser** (`apps/browser`) | Scaffold — Chromium MV3 unpacked dogfood target (v1) |
| **Mobile** (`apps/mobile`) | Reserved — next client on the same protocol |

This is **not** [agent-browser](https://github.com/cfpperche/tachyon) CDP automation. That product drives an agent-owned browser. Companion is the **human’s** browser talking to the engine (send tab → task, approvals, pairing).

Product design: Tachyon SDD **414** (`docs/specs/414-browser-user-companion` in the ADE repo).

## Monorepo layout

```text
apps/browser/              Chromium MV3 extension
apps/mobile/               Reserved for the mobile companion
packages/protocol/         protocolVersion + request/response shapes
packages/api-client/       Pair / capture / approvals client (stubs in v0.1)
```

## Requirements

- Node 20+
- Chromium-based browser for unpacked load
- A running Tachyon engine (pairing endpoints land in ADE slice 2)

## Develop

```bash
npm install
npm run build
npm run typecheck
```

### UI surface: Chrome Side Panel

Toolbar icon opens a **browser side panel** (docked, same class as Claude in Chrome),
not a tiny action popup. Implemented with the MV3
[`chrome.sidePanel`](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) API:
`side_panel.default_path` + `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`.

### Install for Chrome (local package)

```bash
npm run pack:chrome
# → dist/releases/tachyon-companion-browser-<version>.zip
# → dist/releases/tachyon-companion-browser-<version>/   (Load unpacked)

# One-shot helper (prints paths; optional Chrome launch with isolated profile):
npm run install:chrome
npm run install:chrome:launch   # opens Chrome with the extension preloaded
```

Manual:

1. `npm run pack:chrome`
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked**
3. Select `dist/releases/tachyon-companion-browser-<version>/`
4. Pair: in Tachyon (Dev Host), command **Tachyon: Pair Companion (show code)** → paste base URL + code in the popup

Raw build only (no release zip): `npm run pack:browser` → `apps/browser/dist-unpacked/`

## Protocol

- **Server owns semantics** — Tachyon engine `protocolVersion` and fail-closed pairing.
- **This repo mirrors** client types in `@tachyon-companion/protocol`.
- v1: human-push only (send tab → task); agent-pull tools are later.

## Privacy

See [PRIVACY.md](./PRIVACY.md). v1 default: active tab + user gesture; no cookies to agents.

## License

GPL-3.0-or-later (aligned with Tachyon).

## Related

- ADE: https://github.com/cfpperche/tachyon
- Board: Tachyon Mission Control tasks under SDD 414 (`t-32c627` scaffold, …)
