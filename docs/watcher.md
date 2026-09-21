# Watcher — the /tokens dip-buying daemon

The `/tokens` tab + `dip-watcher.mjs`: watch a token's pool for large sells,
market-buy the dip, and/or run a scheduled cadence buy. One watcher per
token per chain per user (`dip_watchers`). This is the ONLY execution path
that runs unattended by default (autonomy mode) without a manual click —
see `CLAUDE.md` § Trading modes.

## Files

| File | Purpose |
|---|---|
| `dip-watcher.mjs` | Always-on daemon (pm2 `imd-watcher`) — WS Swap-event subscriptions, qualifying-sell detection, dip + scheduled plan buys, wallet-position refresh. Re-checks the DB every 30s; plan changes need no restart. |
| `dip-swap.mjs` | Venue discovery/quoting/execution shared with the watcher: `findBestV4Pool`, `buyDip`/`buyToken`, `sendV4Buy`, curve-coin helpers (`getCurveCoinState`, `getImdPerEth`) |
| `db.mjs` | `dip_watchers`, `dip_trades`, `accumulation_strategies`, `strategy_executions` |
| `dashboard.mjs` | `/api/watchers/*` routes (add/remove/set-plan/exit), `buildSellTx` (manual exit's direct-sign builder) |
| `direct-sell.mjs` | `buildDirectV4Sell`/`buildDirectCurveSell` — the builders `buildSellTx` calls for co-pilot manual exits |

## How the daemon works

1. Add a token, then **Set plan** (budget, period, base buy + cadence, dip
   buy + threshold, optional pool override) — or apply a Zooch AI-planned
   strategy. Both write to `accumulation_strategies` and execute identically.
2. `dip-watcher.mjs` resolves the best venue: **V4 first** (Dexscreener venue
   list → on-chain StateView verification → poolId→poolKey derivation; V4
   uses native ETH as currency0), falling back to V3 (deepest fee tier). A
   manual pool override wins when set.
3. WebSocket subscription: V3 pools directly; V4 through the singleton
   PoolManager with the poolId as topic filter. Sell detection: ETH-in/
   token-out deltas, USD-sized via the chain's ETH/USD price source.
4. On a qualifying sell (or the plan's cadence) it buys: V3 via
   `SwapRouter02.exactInputSingle`; V4 via Universal Router (SWAP_EXACT_IN
   0x06, SETTLE_ALL 0x0c, TAKE_ALL 0x0f — never add a SWEEP after TAKE_ALL,
   it reverts `InsufficientToken`).
5. Every buy is pre-flight guarded and recorded in `dip_trades`; budget
   reservation is transactional (overlaps/restarts can't double-spend). A
   budget/allocation-exhausted error auto-pauses the strategy — it never
   frees itself on its own.

## Manual exit (`/api/watchers/:id/exit`, `buildSellTx` in `dashboard.mjs`)

Co-pilot mode routes through direct-sign (2026-09-21) — the user's click IS
the approval, same architecture as Sniper's manual buy/sell (see
`docs/sniper.md` and `CLAUDE.md` § Direct-sign manual trades):

- **Curve coin** (`getCurveCoinState` resolves): `buildDirectCurveSell`
  wraps `sellCurveCoin`.
- **AMM venue** (V4, saved pool or auto-resolved): `buildDirectV4Sell` wraps
  `executeV4Sell`, which stages the Permit2 allowance chain automatically.
- Autonomy mode calls `executeSniperSell` directly (server-side session key).

### "Sell 100%" precision (2026-09-21 fix)

The exit modal opens **defaulting to 100%** (`setExitPct(100)` runs on
open) — this used to compute the sell amount from a client-side display
float (`exitCtx.balance`, already rounded for the input box) and round-trip
it back to wei server-side, which can overshoot the real on-chain balance
on a large-supply token (same class of bug as the Sniper sell — see
`docs/sniper.md`). Fixed: the client tracks whether "100%" was the last
preset clicked (`exitCtx.sellAll`, cleared the instant the user types a
custom amount) and sends `sellAll: true` instead of trusting its own
number. The server then reads the EXACT on-chain balance via
`getTokenBalance` and passes a full-precision decimal string through to
`buildSellTx` — no float round-trip anywhere in a "sell all" request. A
manually typed partial amount is unaffected (unchanged float path).

### Launchpad-coin guard — removed

A storage-slot-0 balance probe (`probeRawErc20Balance`, `launchpad-token.mjs`)
used to gate curve-coin exits with "this coin's balance lives in the
launchpad's curve ledger... sell it on the launchpad" whenever it read zero
in the conventional ERC-20 storage slot. Removed 2026-09-21 — the probe
produced a false positive on VANGUARD (a live `eth_call` of the real sell
simulated clean, and the wallet had already sold half its position
externally via the launchpad for real ETH). IMD launchpad tokens are
trusted; see `CLAUDE.md` § Honeypot Guard for the full story. Don't re-add
a balance-storage heuristic as a launchpad-coin gate.

## Honeypot auto-pause

A successful exit swap that delivers no quote-asset proceeds ("HONEYPOT
GUARD" in the logs) auto-pauses the watcher + strategy and stamps
"HONEYPOT SUSPECTED" on Trades — this is a NON-launchpad-coin safety net
(dollar-quoted or generic AMM tokens); see `CLAUDE.md` § Honeypot Guard.

## Sniper interop

A token bought on Sniper then exited via the Watcher (or vice versa) would
split the P/L ledger across `sniper_trades` and `dip_trades` — watcher exits
are mirrored into `sniper_trades` until the ledgers fully reconcile. A
Sniper→Watcher migration (`/api/sniper/migrate`) carries the sniper's
chosen pool forward so `computeWalletPosition` doesn't have to re-resolve a
hooked/token-only-V4 venue blind.
