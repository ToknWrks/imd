# VPS Deployment — Accumulate (IMD Launchpad Terminal)

How to run accumulate on a VPS alongside the AgentSignal Trader (`/trader`,
per `trader/docs/vps-trader.md` Phase 3b) without breaking anything.

**Model:** Fast Vault signing (user sets it up in the Settings tab — no key
file to hand-copy), persistent pm2 processes for the dip-watcher, scoped
control scripts so accumulate can never touch another app's processes.

---

## 0. Threat model — read honestly before trusting this box

The VPS holds the Fast Vault **device share** (`data/vault.vult`) AND its
password (`.env`). Together those are everything the legitimate signing
process needs — an attacker with both can impersonate the device and
VultiServer will co-sign. The 2-of-2 split protects against **VultiServer**
being malicious or down; it does NOT protect against a full VPS compromise.

What the vault model actually buys you (vs a raw `AGENT_PRIVATE_KEY`):

- **Revocability.** A stolen raw key is gone forever. A stolen device share can
  be killed by resharing/rotating the vault from another device.
- **Partial-exfiltration resistance** — the share alone (without
  `VULTISIG_PASS`) cannot sign. Only true if the password is NOT on the same
  box; §3 stores it there, so this line is currently aspirational.

What it does NOT buy: prevention. If the host can sign without you, a
compromised host can lose everything in that wallet. The real bound is
**operational**: fund the vault wallet with only the active plans' budget + a
gas float, sweep profits out on a schedule, and monitor balance changes. The
only architectures that cap the loss on-chain (compromised host ≠ wallet
drained) are allowance/executor-contract models or ERC-4337 session keys —
not built here.

The dashboard is bound to localhost and reached via SSH tunnel — it is never
exposed to the public internet. That reduces the probability of compromise;
it does not change what a compromise costs.

## 1. Prerequisites (VPS)

```bash
node -v      # need 22.x — same as the trader
npm i -g pm2
```

Ubuntu/Debian extras: `sudo apt install -y build-essential python3`
(better-sqlite3 compiles a native module on install).

## 2. Install (coexists with the trader)

```bash
git clone https://github.com/ToknWrks/accumulate ~/accumulate-imd
cd ~/accumulate-imd
npm install
cp .env.example .env
```

The two apps are fully isolated — separate dirs, PM2 names, ports, and SQLite
files (`imd-*` vs `trader*`; 4210 vs 4100). `iml.sh`/`npm run stop` here only
targets `imd-dashboard`/`imd-watcher` **by name** — never `pm2 stop all`
(that would kill the trader; this is enforced in `imd.sh`, see its header).

## 3. `.env` — accumulate-specific values

```
ALCHEMY_API_KEY=<your key — works for both apps; read-only RPC, safe to share>
VAULT_ACTIVE=true
VULT_FILE_PATH=./data/vault.vult
VULTISIG_PASS=<vault password, if the vault is encrypted>
# OPENAI_API_KEY / OPENAI_MODEL       — only if you use Zooch reviews
# UNISWAP_API_KEY / THEGRAPH_API_KEY  — optional evidence sources
```

Do **not** copy the trader's `.env` and do **not** reuse its vault (see §5).

## 4. First run

```bash
./imd.sh start
# → dashboard on :4210, bound to all interfaces — keep the firewall closed to it

# From your laptop:
ssh -L 4210:localhost:4210 <vps>
# then open http://localhost:4210
```

**Vault setup happens in the UI (Settings tab):**
1. Create a NEW Fast Vault (email-OTP flow) — or import a `.vult` backup made
   for this deployment.
2. Confirm the wallet address shown on Settings.
3. Fund it with the plan budget + gas float only.

```bash
# Boot persistence so the watcher survives VPS reboots:
pm2 save
pm2 startup   # run the command it prints (sudo)
```

## 5. Vault discipline (read before copying any .vult)

- **One vault share per app, per machine.** Two processes signing with the same
  device share race each other's MPC sessions (`waitForPeers` stalls — the bug
  `trader/vultisig-vault.mjs` documents) and race each other's nonces on-chain.
- Trader and accumulate therefore get **separate Fast Vaults and separate
  addresses** — per-app blast radius. A compromise of one app's wallet costs
  only that app's balance; this is the primary loss cap, per §0.
- The vault file IS a private key split in half. Back up
  `~/accumulate-imd/data/vault.vult` (and the VPS `.env`) like production
  secrets — encrypted, off-box.
- **Optional hardening (password off-box):** leave `VULTISIG_PASS` unset in
  `.env` and supply the vault password at process start from your secret
  manager instead (`systemd EnvironmentFile` on a root-only file, or inject at
  runtime). Then file-theft alone is inert. Costs: restarts need the password
  available headlessly — decide deliberately, don't half-do it.

## 6. Operations cheat-sheet

```bash
cd ~/accumulate-imd
./imd.sh status          # only imd-* apps
./imd.sh restart         # pick up dashboard.mjs / dip-watcher.mjs changes
./imd.sh logs            # tail both imd processes
./imd.sh stop            # stops watcher first, then dashboard — nothing else
node --test alpha.test.mjs
```

- **Never** `pm2 stop all` / `restart all` on a shared box — that's the whole
  reason `imd.sh` is scoped (patched 2026-09-16).
- The watcher holds the Alchemy **WebSocket** for dip detection; scheduled
  plan buys are pure HTTP/RPC and self-heal after restarts either way.
- After editing `dashboard.mjs` or any module, `./imd.sh restart` — the ESM
  module graph is cached at boot (live-reload does not exist).

## 7. Health checks

```bash
pm2 status imd-dashboard imd-watcher      # both "online"
curl -s localhost:4210/api/wallet | head -c 200    # signer resolves
tail -f ~/.pm2/logs/imd-watcher-out.log    # swap-event ticks
```

Known failure signatures:
- `VultiServer unreachable` / keysign timeouts → vault co-sign down; the trader
  halts on this (circuit breaker, Phase 3). Accumulate does NOT yet — treat
  this as the first port from the trader codebase if errors appear.
- `ROBINHOOD_MAINNET is not enabled` — stale Alchemy entitlement noise; ignore
  unless you're using chain 4663 (not supported on vault signing anyway).
- Watcher silent for hours with an active plan → check
  `pm2 logs imd-watcher --err --lines 50` for WS drop messages (the watcher
  has no auto-reconnect yet — see Risks in CLAUDE.md).

## 8. What is intentionally NOT supported on the VPS

- **Robinhood Chain (4663)** — VultiSig's Chain enum has no 4663, so vault
  signing can't sign there. Ethereum mainnet only, which is what this
  deployment targets.
- **Base sniper** — vault signing is Ethereum-only today (`.env.example`).
  Keep the raw-key path off the VPS.
- **MM watcher** — mainnet-only build; `pm2 delete accumulate-mm-watcher` is
  a different app's business, not this one's.

## 9. Multi-tenant future (not now)

Same open questions as `trader/docs/vps-trader.md`: one process per user vs
shared loop, per-user Postgres, in-UI vault-share onboarding, failure
visibility, pricing. Nothing in this runbook blocks that path — the vault
model carries over verbatim.
