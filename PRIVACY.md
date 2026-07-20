# Privacy — Tachyon Companion

_Last updated: 2026-07-20 · Scaffold for product v1_

## What Companion is

Tachyon Companion is a user-installed browser extension (and later mobile apps) that **pairs with a Tachyon engine you control**, typically on your machine. It is not a multi-tenant SaaS that scrapes your browsing by default.

## Data we intend to handle (v1)

| Data | When | Where it goes | Agents see it? |
|---|---|---|---|
| Pairing code / session token | Pair / unpair | Local extension storage + your Tachyon engine | No (companion credential ≠ agent Bridge token) |
| Active tab URL + title | You click **Send to Tachyon** | Task on your Tachyon board | Yes — only what you sent |
| Optional text selection | Same gesture | Task body | Yes — only what you sent |
| Approval Accept/Deny | You resolve an approval | Your Tachyon engine approval records | Via normal approval status APIs |

## What we do **not** send (v1 principles)

- Cookies, passwords, autofill, or raw `Authorization` headers
- Full browsing history or always-on page content
- Screenshots unless a later version adds an explicit gesture (evidence path)

## Permissions (browser)

v1 aims for **least privilege**: `activeTab` (or equivalent) plus user gesture for capture. Avoid always-on broad host access unless a later phase documents why.

## Storage

- Extension stores pairing state locally in the browser profile.
- Task content lives in your Tachyon workspace (same trust boundary as the ADE).

## Offline / unpair

- If the engine is down, Companion fails closed or queues only with clear UI — it does not invent orchestration.
- Unpair drops the companion session; re-pair requires a new code from Tachyon Control (or equivalent).

## Contact / product

Source: https://github.com/cfpperche/tachyon-companion  
Engine product: https://github.com/cfpperche/tachyon

This document will be updated before any Chrome Web Store / Firefox Add-ons listing.
