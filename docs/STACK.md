# Tachyon Companion — browser extension stack (locked)

_Status: ratified 2026-07-20 with maintainer. Mobile is a **separate** app/proposal — not this stack._

## Browser extension (`apps/browser`)

| Layer | Choice |
|---|---|
| Language | TypeScript |
| Bundler | esbuild |
| Chrome | MV3 — service worker + **side panel** (`chrome.sidePanel`, no action popup) |
| Side panel UI | **Preact** + **preact/compat** |
| Styling | **Tailwind CSS** |
| Primitives (a11y) | **Radix UI** (`@radix-ui/react-*`) via preact/compat |
| Component kit | **Our own** library under the monorepo (not shadcn; we own wrappers + tokens) |
| Protocol | `@tachyon-companion/protocol` |
| HTTP client | `@tachyon-companion/api-client` |

### Explicit non-choices

- **No shadcn/ui** — we maintain `packages/browser-ui` (name TBD) ourselves on top of Radix + Tailwind.
- **No React** as the app runtime — Preact only; React types only through compat for Radix.
- **No shared app with mobile** — mobile gets its own product/stack later.
- **No** importing Tachyon ADE webview kit into the extension.
- Service worker + content scripts stay **TypeScript only** (no Preact/Radix in those entrypoints).

### Package layout (target)

```text
apps/browser/                 # MV3 extension
  src/background.ts           # SW — no UI framework
  src/sidepanel/              # Preact app
  src/content/                # tab control — TS vanilla
packages/protocol/
packages/api-client/
packages/browser-ui/          # design tokens + our components (Preact + Tailwind + Radix)
```

## Next

1. Define **design system** (tokens, type, spacing, status colors, density for ~320–400px panel).
2. Scaffold `packages/browser-ui` and migrate side panel off ad-hoc CSS.
3. Continue product slices (tab control, etc.) on top of the DS.
