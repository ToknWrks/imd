# Hosted Accumulate — Plan (updated 2026-09-18)

Supersedes the 2026-09-09 vault-only plan. Reflects the wallet-connect +
smart-account migration (2026-09-17) and the co-pilot build (2026-09-18).

## Decision summary (current)

- **Hosting target**: unchanged — Hetzner VPS, PM2 behind Caddy TLS (or SSH
  tunnel for single-user).
- **Wallet model: CHANGED.** VultiSig vault-only is obsolete. The interactive
  signer path is now **Connect wallet → browser-signed funding →
  MultiOwnerLightAccount smart wallet (session key)** — see
  `docs/smart-account-signer.md` and `CLAUDE.md` § Wallet-Connect. The legacy
  VultiSig/raw-key paths remain for headless setups but are deprecated in the
  UI.
- **NEW: Co-pilot mode (built 2026-09-18, `copilot.mjs`/`copilot-ui.js`).**
  Global Settings toggle (`COPILOT_ACTIVE`): every trade (dip, sniper, MM)
  enqueues a sign request; the dashboard pops an approval modal; the user's
  browser wallet signs via EIP-1193; timeout/decline = skipped and logged,
  never traded without explicit approval. **The server holds no key material
  in this mode** — the strongest possible custody posture for a hosted app.
  Default off; autonomy (session key) remains the default signer.
- **Reference app**: `github.com/ToknWrks/robinhood-lp` (Range Desk) for auth +
  DB patterns still applies.

## What is DONE (since the original plan)

- ✅ Smart-account signer (MultiOwnerLightAccount, session key, AA bundler) —
  live, signs all trades in autonomy mode.
- ✅ Browser-signed funding, smart-wallet activate, move in/out (100% sweeps
  clamp to balance − exact gas cost).
- ✅ Co-pilot mode end-to-end: SSE sign-request stream, approval modal with
  decoded summary + countdown, header badge, Settings toggle, request ledger
  (`copilot_requests`), skip-and-log timeout semantics, unit-tested lifecycle.
- ✅ Connect-wallet header session (address-only persistence).
- ✅ VPS runbook (`docs/vps-deploy.md`) — provision → pm2 → scoped control →
  health checks; coexists with the trader app.

## Phase 1 — host it for yourself (the near path)

Everything needed to run the CURRENT single-user app on a VPS safely:

1. **Auth gate on the dashboard** — today there is NONE; anyone reaching the
   port can add tokens, change plans, read positions, resolve/decline co-pilot
   requests, and hit trade APIs. Minimum: password gate + session cookie on
   every route including `/api/copilot/*` (SSE included — request summaries
   leak trade intent). HTTPS (Caddy) or SSH-tunnel-only binding.
2. **WS reconnect + watchdog** (`dip-watcher.mjs`, known TODO) — a dropped
   Swap-event subscription silently kills dip detection. Resubscribe-on-drop;
   alert/watchdog when dead > N minutes. Scheduled buys self-heal; dips don't.
3. **Alerting** — trade failures, low gas balance, dead subscription,
   signing failures currently only log/ledger. Telegram or email push.
4. **Litestream** (or volume snapshots) — `data/accumulate.db` is now the
   money record; single-file loss = history gone.
5. Standard hardening per `docs/vps-deploy.md` §0/§5: SSH-keys-only, ufw,
   secrets off-box where practical, fund-only-the-budget discipline.

Phase 1 signers: autonomy (session key, server-side) for unattended trading,
or co-pilot for approve-everything. Both are built. Co-pilot over an SSH
tunnel is the safest personal-hosted configuration (zero server-side keys).

## Phase 2 — other users (the real work)

Multi-tenancy does not exist. These are the gaps, roughly in build order:

1. **Auth + users first** (Better Auth pattern from robinhood-lp).
2. **`user_id` everywhere** — `dip_watchers`, `dip_trades`,
   `accumulation_strategies`, `sniper_*`, `mm_*`, `copilot_requests`, gas
   ledger. Every engine loop and route threads the user id.
3. **Per-user config** — ALCHEMY_API_KEY (and optional AI/indexer keys) move
   from `.env` to encrypted per-user rows; daemon iterates all users' watchers
   with per-user error isolation + rate limits (Alchemy free-tier caps shared
   10-blocks-per-getLogs across users).
4. **Signer cache fix** — `_signerPromises` is keyed `chainKey` only; multi-user
   hands user A's signer to user B. Key it `userId:chainKey`. Same for the
   co-pilot signer cache and the connected-wallet registry (one
   `CONNECTED_WALLET` today).
5. **Per-user smart accounts or per-user co-pilot.** Two viable postures:
   - **Co-pilot by default (recommended):** each user connects their own
     browser wallet; the server proposes, the user signs; non-custodial by
     construction. SSE + resolve/decline must be per-user isolated + authed.
     No server-side key material at all.
   - **Session key per user:** user creates a session key in Settings, server
     signs UOs for their account. Autonomy for unattended dips, but the server
     then holds each user's session key — Phase 2 on-chain spend caps
     (`docs/smart-account-signer.md`) become the custody mitigation.
6. **Per-strategy engine loop** — one daemon iterating all users' active
   watchers/strategies with isolation; or one pm2 process per user (simpler,
   fine at small scale).
7. **Dashboard multi-user** — co-pilot badge/modal per user session; request
   queue filtered by user; per-user trade/position views.
8. **Ops before inviting others:** per-user failure alerting, spend/failure
   dashboards, ToS/custody disclosure (trivial under co-pilot: "the server
   never holds your keys; you approve and sign every trade in your browser"),
   Litestream multi-tenant sizing, pricing decision.

## Custody posture (decision, superseding the vault discussion)

The original plan's custody problem (server holds device share + password =
de facto custodial) **dissolves under co-pilot**: the hosted server's role is
proposal + bookkeeping only; signatures happen in the user's browser wallet.
Session-key autonomy remains available for users who want unattended dips,
bounded by funding discipline now and on-chain spend caps later.

## Operational gaps that hosting makes mandatory (unchanged in kind)

- WS reconnect + watchdog (Phase 1 item 2)
- Trade-failure / low-gas / dead-subscription alerts (Phase 1 item 3)
- Signing-failure circuit breaker (port from trader codebase if errors appear)

## Non-goals for hosted v1

- Robinhood Chain (4663) auto-trading (WS + signer gaps; the MM tab is already
  mainnet-only and hidden).
- Per-user VultiSig vaults — superseded by co-pilot / session keys.
- In-browser key custody beyond co-pilot signing (no WalletConnect signing
  relays; the user's own extension is the signer).
