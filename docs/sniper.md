# Sniper — manual snipe, sell, autosell, P/L ledger

The `/sniper` tab: enter a token, discover venues, buy/sell manually, arm an
autosell, track P/L. One "active" token per chain per user
(`sniper_recent_tokens`). Supports ethereum, base, robinhood
(`SNIPER_CHAINS` in `sniper-routes.mjs`).

## Files

| File | Purpose |
|---|---|
| `sniper-swap.mjs` | Chain/network registry for the sniper, `executeSniperBuy` (V4/V3/Aerodrome/V2 dispatch), quoting helpers |
| `sniper-extras.mjs` | `discoverPools`, `getSniperPosition`, `getTokenBalance`, `executeV4Sell` (Permit2-staged), `executeSniperSell` (top-level sell dispatcher), `resolveSellVenue`, gas-ledger tx wait |
| `sniper-routes.mjs` | `/api/sniper/*` handlers — buy, sell, verify (round-trip probe), approvals (legacy/unused), position, wallet-sync, migrate-to-Accumulate |
| `sniper-page.mjs` / `sniper-ui.mjs` | Page shell + client JS — discovery, buy/sell forms, autosell controls, P/L table |
| `sniper-autosell.mjs` | Unattended 100%-sell trigger loop (`sniper_autosells`), runs inside the dashboard process |
| `sell-probe.mjs` | Empirical sell-deliverability probe (tiny sell + quote-asset balance-delta) — NOT used for IMD launchpad coins (see below) |
| `direct-sell.mjs` | `buildDirectSniperBuy`/`buildDirectSniperSell` — co-pilot manual-trade builders (see `CLAUDE.md` § Direct-sign manual trades) |
| `launchpad-token.mjs` | Storage-slot-0 balance probe, unused since 2026-09-21 (see below) |

## Buy dispatch

`/api/sniper/buy`: a chosen AMM pool (`pool.dex` set from "Check liquidity")
goes through `executeSniperBuy` (V4/V3/Aerodrome/V2, sized in ETH). No pool
chosen (skipped discovery, or the token is an IMD-launchpad curve coin with
zero AMM venues) dispatches through `dip-swap.mjs`'s `buyToken`, which picks
curve vs routed-dip automatically. Buys pay `msg.value` — no Permit2/approve
step needed, except the Robinhood WETH-pool pre-wrap path (`sendV4Buy`).

## Sell dispatch (`executeSniperSell`, `sniper-extras.mjs`)

In order:
1. **Curve-native** — `pool?.dex === "CURVE"` or (`chainKey === "ethereum"`
   and no pool chosen): tries `getCurveCoinState` first; if it resolves,
   sells through `curve-buy.mjs`'s `sellCurveCoin` (Permit2-staged, same
   hook-consumed-swap mechanics as a curve buy, reversed).
2. **Robinhood LONG-platform** (stock-paired tokens, no pool chosen):
   `executeLongSell` — TWO sequential txs (token→stock, then stock→ETH).
   Never safe to build as a single direct-sign step (see below).
3. **V3_DOLLAR** (delivers USDC/USDG instead of ETH) — `executeV3DollarSell`.
4. **Proceeds sanity guard** — quotes the sell and compares against a fair
   value implied by `discoverPools`' 0.01-ETH reference probe; refuses if
   quoted proceeds are <50% of fair value ("the pool's hook/fee is consuming
   the swap"). A successful receipt proves nothing about proceeds on its
   own — see the Honeypot Guard section in `CLAUDE.md`.
5. **V4** — `executeV4Sell`: checks/sets the Permit2 allowance chain
   (erc20→Permit2, Permit2→router) BEFORE the swap. This is what direct-sign
   buys/sells stage across repeated clicks (see below).
6. **V3/V2/Aerodrome** — plain `ERC20.approve(router, amount)`, no Permit2.

## Direct-sign (co-pilot manual buy/sell, 2026-09-21)

`/api/sniper/buy` and `/api/sniper/sell` check `signer_mode` — co-pilot
returns a built tx (`buildDirectSniperBuy`/`buildDirectSniperSell` in
`direct-sell.mjs`) for the browser to sign directly, instead of the old
approval-modal flow. Both wrap the SAME dispatcher functions above via a
capture-signer, so every venue/guard above gets the same staged-approval
treatment for free. **Exception**: Robinhood LONG-platform sells
(`chainKey === "robinhood" && !pool?.dex`) stay on the old approval-modal
path — a two-leg trade can't be re-entrant-staged the way single-call
approve→swap sequences can (leg 2 needs leg 1 already mined). See
`CLAUDE.md` § Direct-sign manual trades for the full mechanics.

## Precision: sell-percent-of-balance must use raw BigInt scaling

`bal.formatted` (a JS float from `getTokenBalance`) round-tripped back to
wei via `BigInt(Math.round(Number(x) * 10**decimals))` can overshoot the
real on-chain balance on a large-supply token — found live on a VANGUARD
100%-sell (offset by 5,189,183 wei, reverted with no approval prompt,
initially misdiagnosed as a Permit2 gap). Fixed in `sniper-routes.mjs`
(`/api/sniper/sell`) and `sniper-autosell.mjs`'s 100%-sell trigger: scale
the raw balance in BigInt, format to a full-precision decimal STRING
(`formatUnits`), which `executeSniperSell` parses back exactly
(`parseUnits`) when given a string. Plain-number amounts (typed values,
probe sizes) keep the old float math unchanged.

## Honeypot guard — NOT applied to IMD launchpad coins

`sell-probe.mjs`'s "Verify sellable" ($1 buy → sell → check real proceeds
landed) and the empirical round-trip verify exist for tokens from anywhere
on-chain. **IMD launchpad coins are trusted — none of them can be a
honeypot** (2026-09-21 direction), so this workflow doesn't apply to them.
A separate storage-slot-0 balance guard (`probeRawErc20Balance`,
`launchpad-token.mjs`) briefly gated launchpad curve-coin sells on
`/tokens` specifically and was removed after producing a false positive
(see `CLAUDE.md` § Honeypot Guard for the full VANGUARD story). The probe
helpers remain in `launchpad-token.mjs`, unused, for a possible future
non-launchpad case.

## Autosell

`sniper_autosells` rows are armed via `/api/sniper/autosell/arm` (target %
above cost basis) and executed by the loop in `sniper-autosell.mjs`
(started from `dashboard.mjs`'s `startSniperAutoSellLoop()`). Trigger:
position value (ETH) ≥ `cost_at_arm_eth × (1 + target_pct/100)`. A hit sells
100% — subject to the same precision fix above.

## Ledger repair — `scripts/repair-sniper-ledger.mjs` (2026-09-24)

Re-derives one user's `sniper_trades` rows for one token from on-chain truth.

```bash
node --env-file=.env scripts/repair-sniper-ledger.mjs <userId> <token>          # dry run (read-only DB handle)
node --env-file=.env scripts/repair-sniper-ledger.mjs <userId> <token> --apply  # writes — back up data/ FIRST
```

Fixes, per `status='ok'` row with a tx hash:
1. Smart-wallet UserOperation reverted → `status='error'`
2. **Plain tx reverted** (e.g. `DIRECT SIGN` from the owner EOA — no
   UserOperation, receipt `status != success`) → `status='error'` *(added
   `b9662ca`; the first version missed these)*
3. Transfer between the user's own wallets → `status='transfer'`
4. Sell proceeds wrong (V4 decode stored the TOKEN quantity as ETH) → real
   ETH from native/internal transfer legs. Sell rows = `SELL|PROBE|AUTOSELL`
   prefix **or** `(sell)` in `dex`.
5. Buy cost NULL/wrong → ETH out from transfer legs
6. **`token_amount` NULL on a successful trade** → net token Transfer *(added
   `b9662ca`)*

Applied so far: IMD (12 rows, 0/44 left), VANGUARD (7 rows for `0xa71f…`,
1 for `0x79c0…`; 0 left for both). Worst one: VANGUARD #66, a sell recorded
at 0.3383 ETH that really paid 0.000622 ETH (≈544×) — realized P/L went from
+0.338 ETH to +0.00016 ETH. Other watched tokens ($BLD, PEPESWARM, FWAI,
ICE, BALLOON) have no `sniper_trades` rows — nothing to repair.

Limits: assumes 18 decimals; Alchemy free tier caps `eth_getLogs` at 10
blocks, so the script uses `alchemy_getAssetTransfers` + receipts instead.

## Migrating to Accumulate

`/api/sniper/migrate` creates a dormant `dip_watchers` row (no plan, no
active flag) carrying the sniper's **chosen pool** (`pool_address`) — a
watcher with no pool breaks `computeWalletPosition` on hooked/token-only-V4
tokens. Re-migrating an existing watcher backfills the pool if missing but
never overwrites an existing one.

## Legacy/unused

`/api/sniper/approvals` and `/api/sniper/approve` predate the per-venue
approval chains built into `executeSniperSell`/`executeSniperBuy` and are
not called by the current UI — remove them if nothing re-adopts the flow.
