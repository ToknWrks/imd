# VPS Deployment — IMD Launchpad Terminal (as-built, 2026-09-19)

> **This VPS is production. The laptop is for editing code only.**
> Host `204.168.185.82` (hostname `AgentSignal1`), login
> `ssh -i ~/.ssh/id_hetzner root@204.168.185.82`, app dir
> `/root/accumulate-imd`, serves `https://imd.illuminati.co`.
> Every user's wallet, signer mode, session key and trade lives in THIS
> box's `data/` — never answer those questions from a laptop copy.
> Deploy: commit + push locally → here `git pull && ./imd.sh restart`.

How the app actually runs on the Hetzner VPS at `https://imd.illuminati.co`
(legacy `imd.zooch.app` still works during transition). Supersedes the
2026-09-10 vault-only version of this doc — the signer model changed
2026-09-17 (AA smart account) and the app went multi-user + auth-gated
2026-09-18/19. The VultiSig vault path (§6) still exists but is legacy,
deprecated in the UI, and not what hosting runs on today.

---

## 0. Threat model — read honestly before trusting this box

The dashboard is now public (Caddy TLS, real domain) and auth-gated — not
SSH-tunnel-only like the original plan. Every route requires a wallet
signature login (`auth.mjs`), so exposure is not "anyone can trade," but a
full VPS compromise still matters:

- **MASTER_KEY** decrypts every user's secrets (alchemy/session/telegram
  keys) and every registry session key in `data/connected-wallets.json`. It
  is the single most sensitive value on the box — equivalent to a seed
  phrase for every autonomy-mode user's smart wallet.
- **Autonomy-mode users** have a per-user session key held server-side,
  encrypted with MASTER_KEY. A host compromise that also gets MASTER_KEY can
  sign UserOperations as those users, bounded only by each smart wallet's
  actual balance (no on-chain spend cap yet — Phase 2, see
  `docs/smart-account-signer.md`).
- **Co-pilot-mode users** (the DB default for new users, `signer_mode`
  defaults to `'copilot'`) hold NO key material on the server at all — every
  trade is an approval modal signed by the user's own browser wallet
  (connected via the header's Reown AppKit button). This is the strongest
  custody posture available today; recommend it for anyone who doesn't need
  unattended trading. Switching to autonomy is a per-user toggle in Settings.
- **MultiOwner** semantics mean the connected wallet that created a smart
  account retains on-chain ownership and can recover via `addOwner` even if
  the session key is lost — but treat MASTER_KEY + the registry as
  seed-equivalent regardless.
- The real bound is still operational: fund smart wallets with only the
  active plans' budget + a gas float, monitor balance changes, back up
  `data/` (see §5).

## 1. Prerequisites (VPS)

```bash
node -v      # need 22.x
npm i -g pm2
```

Ubuntu/Debian extras: `sudo apt install -y build-essential python3`
(better-sqlite3 compiles a native module on install). Caddy for TLS
termination in front of pm2's port.

## 2. Install

```bash
git clone https://github.com/ToknWrks/imd ~/accumulate-imd
cd ~/accumulate-imd
npm install
cp .env.example .env
```

The box also runs the unrelated `agentsignal` app and (for the sibling fork)
`/accumulate` on port 4200 — this app is isolated by dir, pm2 process names
(`imd-*`), and port (4210). Never touch another app's processes or port.

## 3. `.env` — set BEFORE first boot

```bash
MASTER_KEY=<long random hex>   # REQUIRED — missing = hard throw on any secret write
ALCHEMY_API_KEY=<key>          # required — WS subscriptions, AA bundler, transfer scans
ALLOWED_WALLET=0x...           # optional single-wallet pin; else REGISTRATION governs
REGISTRATION=open              # open | closed
COPILOT_ACTIVE=false           # legacy global flag; per-user signer_mode toggle lives in Settings
# OPENAI_API_KEY / UNISWAP_API_KEY / THEGRAPH_API_KEY — optional
# ALERT_TELEGRAM_BOT_TOKEN / ALERT_TELEGRAM_CHAT_ID — optional
IMD_DASHBOARD_PORT=4210
```

There is no env-level smart-account signer (v1 removed 2026-09-24):
`SMART_ACCOUNT_ACTIVE` and `AA_SESSION_KEY` are gone — delete them from
`.env` if present. Every user's wallet is v2 (owned by their EOA), and
autonomy signs with that user's entity-1 session key from the registry.

## 4. First run

```bash
./imd.sh start
# → imd-dashboard on :4210 (Caddy proxies imd.illuminati.co → :4210 with TLS)
# → imd-watcher runs the always-on dip daemon alongside it
```

No SSH tunnel needed — the auth gate (wallet-signature login) is what makes
public exposure safe.

**Default per-user signer UX** — no `.env` editing per user, and (as of
2026-09-19) no separate login page or separate "connect a smart wallet"
step: clicking the header's **Connect wallet** button IS signing in.

1. User clicks **Connect wallet** in the header (there is no separate login
   document — even a signed-out visitor sees the normal app shell with this
   button; the content area shows a "connect your wallet" prompt until they
   do). The Reown AppKit modal opens, they pick a wallet, and `personal_sign`
   a one-time nonce.
2. On successful verification the server sets the session cookie AND calls
   `ensureWalletSession()` in the same request: unknown wallet → derives its
   v2 smart wallet (owned by that EOA) and records it in
   `data/connected-wallets.json` with NO key; known wallet → returned as-is.
   Automation is granted later in the wallet slideout ("Enable automated
   trading"), which installs a session key as an entity-1 operator.
3. **Settings → Signer** is where the user sees/manages the result: their
   SCW address, and the `copilot` (default — browser wallet approves every
   trade, no server key) vs `autonomy` (server signs with their session key)
   toggle. Nothing here is env-level or operator-configured per user.

```bash
pm2 save
pm2 startup   # run the printed command (sudo) — only when BOTH imd-* apps
              # AND agentsignal's apps are in their intended state; pm2 save
              # snapshots the whole box's boot list, not just this app's
```

## 5. Backup discipline — `data/` IS the key material

`data/` is gitignored, so a fresh `git clone` on a rebuilt box starts with
NONE of it. This caused the 2026-09-18 phantom-wallet incident (see
CLAUDE.md § Key-persistence) — every restart minted new wallets because the
registry didn't exist. Back up, off-box, on a schedule (Litestream or
snapshot):

- `data/connected-wallets.json` — the session-key registry (encrypted at
  rest with MASTER_KEY; legacy plaintext rows upgrade transparently on read).
- `data/accumulate.db` — users table (secrets encrypted with MASTER_KEY),
  all trade/strategy/ledger tables.
- The `.env` file itself (MASTER_KEY, ALCHEMY_API_KEY, ALLOWED_WALLET).

Losing MASTER_KEY without a backup makes every encrypted secret and
registry key permanently unreadable — the funds-safety guard in
`ensureWalletSession()` then **refuses to mint** a replacement wallet over
an unreadable record rather than silently creating a new one, so recovery
means restoring the correct MASTER_KEY, not losing funds outright — but only
if the backup exists.

## 6. Legacy signer paths (not the hosted default)

Two older signer modes still work (env-selected in `signer.mjs`) but are not
what hosting runs on:

- **Raw private key** (`AGENT_PRIVATE_KEY`) — headless/local only, never put
  a raw key on a shared, publicly-reachable box.
- **VultiSig Fast Vault** (`VAULT_ACTIVE=true`, `VULT_FILE_PATH`,
  `VULTISIG_PASS`) — the original single-user MPC vault model. The vault
  file is a private key split in half; the VPS holding both the share and
  the password means a full compromise can still sign (2-of-2 only protects
  against VultiServer itself being malicious/down). One vault per app per
  machine — never share a `.vult` across processes (MPC session races).
  VultiSig's Chain enum has no Robinhood Chain (4663) — Ethereum mainnet
  only if used.

Prefer the AA smart-account path (§0, §3) for anything hosted today; see
`docs/smart-account-signer.md` for the full signer history and rationale.

## 7. Operations cheat-sheet

```bash
cd ~/accumulate-imd
./imd.sh status          # only imd-* apps
./imd.sh restart         # pick up dashboard.mjs / dip-watcher.mjs changes
./imd.sh logs            # tail both imd processes
./imd.sh stop            # stops watcher first, then dashboard — nothing else
node --test alpha.test.mjs
```

- **Never** `pm2 stop all` / `restart all` / `start all` on this shared box
  — it registers/snapshots agentsignal's apps too, and a later `pm2 save`
  can drop an app off the boot list. Restart by exact name only.
- `hostname` before anything destructive: `AgentSignal1` = the VPS,
  anything else = local — local and VPS pm2 are unrelated worlds.
- The watcher holds the Alchemy **WebSocket** for dip detection (with a
  watchdog now — see `ws-watchdog.mjs`); scheduled plan buys are pure
  HTTP/RPC and self-heal after restarts either way.
- After editing any module, `./imd.sh restart` — the ESM module graph is
  cached at boot (no live-reload).

## 8. Health checks

```bash
pm2 status imd-dashboard imd-watcher      # both "online"
curl -sI https://imd.illuminati.co        # 200/302 through Caddy, TLS valid
tail -f ~/.pm2/logs/imd-watcher-out.log   # swap-event ticks
```

Restart checklist after any redeploy (from CLAUDE.md — repeat here because
it's the fastest way to catch a regression): log in (header Connect wallet
button — this is the whole flow now) → same SCW address as before
(phantom-wallet canary) → one test buy dry-run →
`POST /api/gas/backfill` if new trades landed.

Known failure signatures:

- `refusing to mint a new wallet — funds-safety guard` → the registry
  record for that address exists but its key is unreadable (MASTER_KEY
  mismatch, or corrupted `data/connected-wallets.json`). Restore the
  correct MASTER_KEY / backup rather than deleting the record.
- Watcher silent for a while with an active plan → check
  `pm2 logs imd-watcher --err --lines 50` for WS stall/rebuild messages
  (the watchdog should auto-rebuild; a persistent stall past that means the
  Alchemy WS entitlement or network path is down).
- `ROBINHOOD_MAINNET is not enabled` — stale Alchemy entitlement noise;
  ignore unless actively using chain 4663.

## 9. What is intentionally NOT supported / still open

- **No arbitrary-ERC20 move-out UI** — the wallet slideout moves ETH/dollar
  only. Don't let meaningful token balances sit in a smart wallet yet.
- **`mm_trades` / `sniper_autosells` have no `user_id`** — their gas lands
  in the NULL-owner legacy bucket.
- **Gas backfill is manual** — schedule `POST /api/gas/backfill` or run it
  after trade activity.
- **On-chain session-key spend caps** are not installed — autonomy-mode
  custody is bounded by funding discipline, not a contract-enforced cap
  (Phase 2 in `docs/smart-account-signer.md`).
- Full list of hosting/multi-tenant gaps: `HOSTED_PLAN.md`.
