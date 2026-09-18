# Alpha — IMD launchpad discovery

The Alpha tab's data layer. Built 2026-09-14, live-verified against the real
indexer (177 coins pulled, engine boots to `online`).

## The discovery provider — a public GraphQL indexer

The launchpad's own frontend is backed by a **public, unauthenticated GraphQL
indexer** — this replaces the paid-Alchemy-key / Graph-subscription blocker
from IMD_PLATFORM_PLAN.md §4.1 for discovery *and* most enrichment:

```
https://imd-communitycoins-indexer.up.railway.app/graphql
```

Verified capabilities:

- `coins { address poolId symbol name creator supply initialVirtualImd
  virtualImd virtualCoin realImd tradeCount buyCount sellCount volumeEth
  volumeCoin creatorFeesEth burnedImd lastTradeAt createdAt }` — paged
  (`limit`/`offset`, 500/page), `orderBy`/`orderDirection`, `coinFilter`.
- `trades(where: { timestamp_gte: $since })` — filters support
  `timestamp_gt/gte/lt/lte`, `coin`, `trader`, `buy`; fields include
  `coin { address } trader router buy ethAmount imdAmount coinAmount
  creatorFeeEth burnFeeImd virtualImd ... timestamp`. 24h pull = 27 trades
  (tiny platform — a single paged query suffices for a long time).
- `statss(limit: 1)` → single row `id: "launchpad"` with board-wide
  `coins / trades / volumeEth / creatorFeesEth / burnFeesImd / imdBurned` —
  the Board header for free.

Gotchas hit during integration:

- Timestamp filters need `BigInt` variables, not `String`
  (`Variable "$since" of type "String" used in position expecting "BigInt"`).
- `stats` (singular) with `id: "global"` returns null — the real id is
  `launchpad`, fetched via the `statss` list query.
- BigInt fields arrive as strings; always convert via
  `Number(BigInt(v))/1e18`, never `Number(v)` (precision loss).

## Files

| File | Purpose |
|---|---|
| `alpha-engine.mjs` | The engine: indexer sync (coins + 24h trades + stats), curve math (`curvePriceImd`, `coinsSoldPct`, `backingImd`), `tokenScore` (ported verbatim) + `curveTokenScore` (IMD-flow-aware: unique curve buyers > raw volume), GoPlus security (chain id 1), scored queue + JSON cache hydrate/save |
| `alpha.test.mjs` | Unit tests: curve math vs BALLOON's snapshot values, rogue-input clamping, buyer-weighting behavior. `node --test alpha.test.mjs` |
| `scripts/imd-coins.mjs` | One-shot CLI: `node scripts/imd-coins.mjs [limit]` — top by volume + curve progress |
| `scripts/imd_coins_snapshot_2026-09-14.{json,csv}` | First full pull (177 coins) for reference/diffing |

## Deliberate design decisions

- **Everything is provenance-unverified** (`verified: false` +
  `provenance: "unverified — permissionless launch, not sell-probed"`): the
  queue never presents a coin as safe until the Sniper's empirical sell probe
  passes (QUORUM lesson). Badge wires into `verified_at`/`verified_via` later.
- **Reserve IMD is excluded** from the queue (it's not a curve coin). Note
  the indexer carries MULTIPLE "IMD"-symbol coins — identity is the address,
  never the symbol.
- **Scoring**: `Math.max(tokenScore, curveTokenScore)` with the winner's name
  on the row (`scorer` field). Curve score weights unique buyers (×10/30)
  over ETH volume (×12) because curve volume is ~2%-fee-clipped and tiny
  early on — the uniqueBuyers term dominates, per the plan.
- **No invented data**: `hasSecondaryPool` is always `false` for now
  (Dexscreener secondary-pool detection is TODO); holders come only from
  GoPlus `holder_count` (often empty) — no fake holder numbers anywhere.
- `marketCap` requires the ETH/IMD price (`imdUsd`) which the dashboard sets
  on the engine (`alphaEngine.data.imdUsd = …` from the pool slot0 × Chainlink
  ETH); until set, it's 0 and `capSweet` scores the floor.
- The indexer is a **third-party hosted dependency** — it can vanish or lie.
  Before any execution path consumes these numbers, cross-verify the coin's
  curve state against the hook (the same read layer the Board tab will use).
  On-chain fallback for discovery (factory `launch()` events) is TODO.

## Wiring into a dashboard (when dashboard.mjs is forked over)

```js
import { startAlphaEngine, getAlphaQueue } from "./alpha-engine.mjs";
await startAlphaEngine();          // in the server boot path
// in the /api/alpha route:
res.json(getAlphaQueue());          // { items, platform, status, sources, updatedAt, error }
```

Env knobs: `IMD_INDEXER_URL`, `IMD_RESERVE_ADDRESS`, `ALPHA_POLL_MS` (60s),
`ALPHA_POLL_SECURITY_MS` (120s), `ALPHA_TRADE_WINDOW_H` (24),
`ALPHA_TRADE_MAX_PAGES` (6), `GOPLUS_URL` (mainnet by default), `ALPHA_MAX_QUEUE` (120).
