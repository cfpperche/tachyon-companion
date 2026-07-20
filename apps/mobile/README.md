# Tachyon Companion — Mobile

**Reserved** for the mobile external shell (iOS/Android or equivalent).

Product line: same monorepo as the browser companion; shared packages:

- `@tachyon-companion/protocol`
- `@tachyon-companion/api-client`

Do not implement the mobile app until the browser v1 pairing + send-tab + approvals path is dogfooded (Tachyon SDD 414). Stack choice (Expo/RN, Flutter, …) is open.

See the monorepo root [README.md](../../README.md) and ADE SDD `414-browser-user-companion`.

## Status

| Item | State |
|---|---|
| App scaffold | Not started |
| Pairing protocol | Owned by engine; client packages ready for reuse |
| Store listing | N/A |
