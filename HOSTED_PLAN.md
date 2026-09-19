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

## Session 2026-09-18/19 — hosted rebuild + per-user correctness sweep

The VPS rebuild surfaced and fixed a chain of single-user assumptions that
broke under multiple wallets. All landed and verified on the VPS:

- ✅ **Key persistence** (`8915012`): MASTER_KEY required (hard throw),
  registry keys encrypted at rest, no auto-mint on unreadable keys. See
  CLAUDE.md § Key-persistence.
- ✅ **Unified per-user wallet** (`e0d342c`): the registry (per-connected-
  wallet) is the single source of truth; Settings generate dual-writes both
  stores; one resolver (`resolveUserSessionKeyAsync`) everywhere.
- ✅ **Read vs sign wallet split** (`1927d03`, `f896415`):
  `resolveUserReadWallet()` for every balance path (watcher, sniper,
  wallet-sync); trades still sign via `resolveSignerUser`.
- ✅ **Login account selection** (`ac3d8fb`): AppKit connection cache cleared
  before the modal opens — switching wallets actually switches sessions.
- ✅ **Slideout is per-user** (`63eaa4f`): smart-wallet card shows the
  session user's SCW; co-pilot users get a "generate a session key in
  Settings" instruction card instead of a fundable address. Legacy env
  `AA_SESSION_KEY` deleted from the VPS.
- ✅ **Overview is per-user** (`8e8046d`→`25bf3c1`): watchers, sniper ledger,
  and gas breakdown all session-filtered; gas rows owner-stamped at
  record/backfill; 8 legacy rows stamped from trade-table owner lookup.
- ✅ **Login unified with the header Connect-wallet button, CONNECTED_WALLET
  deleted** (2026-09-19): there is no separate login page anymore — the
  header's "Connect wallet" button IS the sign-in flow (connect → nonce →
  personal_sign → verify → reload). This also fixed the bug item #1 below
  used to describe: CONNECTED_WALLET was a single global `.env` value shared
  by every user, so every co-pilot-mode user (the default) saw the SAME
  wallet's balances/header address — whoever last clicked "Connect wallet"
  anywhere. Identity is now always `sessionAddress(req)` (the signed-in
  cookie), threaded per request, never a global/env value. Also fixed:
  `AppKit.subscribeState()` never carries an address (only `subscribeAccount`
  does) — the login flow used to hang with no signature prompt on a fresh
  connect until a page refresh papered over it. See CLAUDE.md Hard-Won
  Lessons for both.

### Still open (found during that sweep, not yet built)

1. `mm_trades` + `sniper_autosells` have no `user_id` (MM never migrated).
2. Gas backfill is manual — sniper buys never record gas at trade time;
   schedule `POST /api/gas/backfill` (cron or watcher timer).
3. No arbitrary-ERC20 move-out UI — slideout moves ETH/dollar only. Build
   before any meaningful tokens sit in a user's SCW (autonomy switch).
4. Shared pm2 daemon with the agentsignal app — scoped commands enforced by
   convention, not by separation. Strongest fix: separate PM2_HOME per app.

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
   co-pilot signer cache. (The connected-wallet registry itself is already
   per-user, keyed by wallet address — the single global `CONNECTED_WALLET`
   env value this used to reference was removed 2026-09-19.)
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
