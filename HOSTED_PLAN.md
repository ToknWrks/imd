# Hosted Accumulate — Plan (reference)

Date: 2026-09-09. No code changed yet — this is the agreed plan for moving the
local-only dip-trading app to a hosted (Hetzner VPS) deployment, vault-only.

## Decision summary

- **Hosting target**: Hetzner VPS, PM2 (dashboard + dip-watcher) behind Caddy TLS.
- **Wallet model: VultiSig Fast Vault only.** No smart accounts / Alchemy
  Account Kit in v1. No raw private keys on the server at all — delete the
  `AGENT_PRIVATE_KEY` path from `signer.mjs` when hosted.
- **Why vault-only works**: the VultiSig path is already proven end-to-end
  locally — `vault.mjs` (create → email OTP → device share → export),
  `signer.mjs` resolves it when `VAULT_ACTIVE=true`, and `buyDip()` in
  `dip-swap.mjs` already executes every swap through `signer.callContract()`,
  so no trading-code changes are needed for the vault itself.
- **Reference app**: `github.com/ToknWrks/robinhood-lp` (Range Desk) — already
  has Better Auth + Postgres/PGLite + wagmi/Reown wallet connect + a signed
  `session-policy.ts` spend-grant model (max USD / daily cap / expiry, enforced
  in paper mode only today). Reuse its auth + DB patterns; its browser-wallet
  model can't do unattended trading, which is why accumulate keeps the vault.

## What has to change

1. **Per-user vault storage (core).**
   - New `wallets` table: `user_id, kind='vault', address, local_party_id,
     encrypted_vult, encrypted_pass, created_at`.
   - Encrypt `.vult` share + password with AES-256-GCM using a master key from
     the VPS environment (never plaintext in the DB).
   - Replace the single `VULT_FILE_PATH` / `VULTISIG_PASS` env vars; load per
     user via `loadVault({ vultPath, password })` (write share to a per-user
     temp/data path, 0700).
2. **Fix the signer cache (landmine).** `_signerPromises` in `signer.mjs` is
   keyed by `chainKey` only — multi-user would hand user A's vault to user B.
   Key it `userId:chainKey`.
3. **`resolveSigner(userId, chainKey)`.** All call sites thread the user id.
   Remove the raw-key fallback entirely; vault is the only kind.
4. **Auth + users.** Better Auth (pattern from robinhood-lp `src/lib/auth/`)
   or, if stays personal/small, a single shared password gate. Every trade API
   gated; HTTPS only.
5. **Per-user config.** ALCHEMY_API_KEY, AI keys move from `.env` to encrypted
   user rows; `dip_watchers` gains `user_id`; daemon loop iterates all users'
   watchers with per-user error isolation + rate limiting.
6. **Vault UX on Settings.** Per-user create (OTP email) or import existing
   device share; keep the `Server-`-share rejection guard in `vault.mjs`.
   Add: deposit card (address + QR), export-share button, "share stored
   server-side" disclosure.

## VPS deployment shape

- PM2 `ecosystem.config.cjs` as today (dashboard + dip-watcher) + Caddy for
  auto-HTTPS.
- Hardening: SSH keys only (`id_hetzner` exists), ufw 22/443, unattended-upgrades.
- SQLite stays (single box, single writer) + **Litestream** streaming backups
  to object storage or Hetzner volume snapshots (trade history = money records).
- Secrets: `.env` app-user-readable only; app data under `/var/lib/accumulate/`, 0700.
- Smallest CX instance suffices; CPX21 for headroom.

## Operational gaps hosting makes mandatory

- **WS reconnect + watchdog** (known TODO in CLAUDE.md): dead Swap-event
  subscription = silent no dip detection. Resubscribe-on-drop; alert if dead
  > N minutes.
- **Trade-failure alerting**: `dip_trades` errors currently only log — notify
  the user (Telegram/email). Also low-gas-wallet alerts.
- **VultiServer reachability healthcheck**: every buy is an MPC co-sign with
  VultiServer; alert on repeated fast-signing failures.

## VultiSig caveats (accepted, not blockers)

1. **Custody posture**: the VPS holds each user's device share + password;
   Fast Vault is 2-of-2 (device + VultiServer), so app + VultiServer can move
   funds. For yourself = hot wallet on your own server (same trust as today's
   env key). For others = de facto custodial → mitigations: export button so
   users can leave with their share, explicit disclosure, and/or restrict to
   "import your own vault, keep your own backup" (hot-standby signer model).
2. **Chains**: ethereum + base only (`VAULT_CHAIN_NAMES`); VultiSig's `Chain`
   enum has no Robinhood 4663 → hosted version drops 4663 auto-trading.
3. **Password recovery**: decide per import whether the app stores the vault
   password (encrypted) or the user keeps sole custody (must remember it).
4. **OTP flow**: create→verify is in-memory (`_pending`, MemoryStorage);
   dashboard restart mid-signup = retry. Session table later, not day one.

## Bigger-picture option (later, not v1)

Alchemy Account Kit smart accounts with **session keys** as a third wallet
kind: user approves one session key whitelisted to router `execute` selectors
with an ETH cap ≈ plan budget and expiry ≈ `end_at` — non-custodial unattended
trading, bounds a server compromise. Port robinhood-lp's `SessionPolicy`
fields into the grant. Do this after v1 proves out; it's the cleanest answer
for hosting other people's money (and the legal posture).

## Phased implementation

1. **Day 1–2**: VPS provision (Caddy + PM2 + Litestream), auth gate, `wallets`
   table, per-user encrypted vault storage, signer cache fix,
   `resolveSigner(userId, chainKey)`.
2. **Day 3**: multi-user daemon loop, Settings writes per-user vaults, export
   button, deposit/funding card.
3. **Day 4**: WS reconnect watchdog + alerts (trade failure, low gas, dead
   subscription, signing failures).
4. **Before inviting others**: custody disclosure/export UX; decide custodial
   vs bring-your-own-vault posture.
