# PONS Launchpad Dashboard — Plan (NOT yet built)

> Status: **plan only — awaiting go-ahead.** Nothing here has been
> implemented. Written 2026-09-10 after verifying the data sources live.
> Scope chosen by Lance: **"Full build: poller + DB table + /launches page
> in the existing dashboard, v1 API feed first."**

## What PONS is

Pons is a pump.fun-style token launchpad on **Robinhood Chain** (chain 4663,
WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`). Two stacks exist:

| | Pons v1 | Pons v2 |
|---|---|---|
| Trading model | Straight into a locked **Uniswap V3** WETH pool | **Bonding curve** first → graduates into a permanently locked **Uniswap V4** pool |
| Factory | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Scale | Active | The big one (~200K+ launches in its first month at ~20K/day peak; >98% never graduate) |

We dip-watch SIRIUS/IF on this chain already, so the RPC + viem plumbing is
proven. At peak activity, Pons v2 out-earned pump.fun in daily fees.

## Data sources (verified live 2026-09-10)

### 1. Pons v1 JSON API — free, no key, CORS open (primary feed)

- Launch feed: `https://www.ponsfamily.com/api/pons-launches`
  - Params: `sort` (`newest|oldest|recentBuys|marketCap|volume`), `age`
    (`all|24h|7d`), `page`, `pageSize` (≤50), `graduatedPage`,
    `graduatedPageSize`, `includeGraduated` (0/1), `v` (cache-buster int)
  - Also: `https://gspotsol.fun/api?...` mirrors the same shape
  - Search: `https://gspotsol.fun/api/search?q=<query>`
- Per token: `https://www.ponsfamily.com/api/pons-token/{address}` and
  `.../api/pons-market/{address}`
- Row shape (confirmed): `factory, token, deployer, pool, pairToken,
  transactionHash, blockNumber, launchedAt, name, symbol, logo(ipfs),
  description, priceUsd, marketCapUsd, liquidityUsd, graduated,
  graduationProgressPct, graduatedAt, latestBuyAt, initialBuyWei, txHash`
- Caveat seen in the wild: the API can lag or go stale ("degraded
  performance" banner on their site). Treat it as best-effort and show a
  "last synced" timestamp in the UI.

### 2. On-chain events — trust-minimized fallback / v2 coverage (phase 2)

- v1: index factory `TokenLaunched(token, deployer, dexFactory, pairToken,
  pool, …)` via viem `getLogs` (docs.ponsfamily.com has the full ABI + a
  viem snippet). Token metadata is readable from the token contract itself
  (`name/symbol/logo/liquidityPool`) and launch params from
  `factory.getLaunchedToken(token)` (gives `isToken0`, `poolFee`,
  `supply` — everything needed for pricing from `slot0`).
- v2: `TokenLaunched` on `0x7eD5…EC7e` / router `0xe33E…2948` (selectors
  `0xf35abbcf`, `0xa72101af`, `0xf85f8e41` — `Call.Output` words 0/1 give
  `token` + `curve`); curve trades emit `CurveBuy`/`CurveSell`; graduation
  sequence is `LaunchSwept` → `GraduationTokensPermanentlyLocked` →
  `PoolGraduated` (graduated pools: Uniswap V4, fee 0, tickSpacing 200,
  hook `0xE5e7…e044`). Bitquery docs map every topic0 if we ever want a
  hosted indexer instead of raw logs.
- v2 curve tokens are invisible to DEX data until graduation — any "new
  v2 launches" view must come from events, not Dexscreener.

## Design

### DB (db.mjs — house style: `CREATE TABLE IF NOT EXISTS` + functions)

```sql
CREATE TABLE IF NOT EXISTS pons_launches (
  token            TEXT PRIMARY KEY,     -- canonical address
  factory          TEXT,                 -- v1 vs v2 by factory address
  symbol           TEXT, name TEXT, logo TEXT, description TEXT,
  deployer         TEXT, pool TEXT, pair_token TEXT,
  tx_hash          TEXT, block_number INTEGER,
  launched_at      TEXT, price_usd REAL, market_cap_usd REAL,
  liquidity_usd    REAL, volume_usd REAL,
  graduated        INTEGER DEFAULT 0, graduation_progress_pct REAL,
  graduated_at     TEXT,
  latest_buy_at    TEXT,
  first_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at   TEXT
);
```

Functions: `upsertPonsLaunch(row)`, `getPonsLaunches({sort, age, filter,
limit, offset})`, `countPonsLaunches()`, `getPonsLaunch(token)`.
Price/volume snapshots overwrite in place (no history table in v1 of this
feature — the API is the history).

### Poller — new file `pons-poller.mjs`, PM2 process #3

- Loop every ~2–5 min: fetch `pons-launches` (`sort=newest`, `age=all`,
  pages 1–3) + (`sort=recentBuys`, `age=24h`, pages 1–3) → upsert by token.
- Also refresh market numbers for launches first seen in the last 48h on
  each pass (cheap: a handful of `/api/pons-token/{t}` calls).
- Bound the DB: tokens with no market cap and no activity after 7 days can
  be pruned by a manual script, not automatically (don't destroy data).
- Cap requests; treat 429/timeouts as skip-and-retry-next-loop. Never
  block the dashboard on the poller.

### Dashboard page — `/launches` in dashboard.mjs

- Nav link "Launches" in `shell()` between Sniper and Trades.
- Reuse the existing table + pill + stat-card CSS. Sections:
  1. **Stat row**: launches synced, graduated count/percent, newest launch
     age, poller last-sync time.
  2. **Filters** (query params, server-rendered like /trades): sort
     (newest / recent buys / market cap / volume), age window (24h / 7d /
     all), graduated toggle.
  3. **Table**: logo (via IPFS gateway, lazy), name/symbol, age, price,
     market cap, volume, graduation progress bar, deployer + tx explorer
     links (Robinhood Chain explorer via `explorerLink`).
- Optional follow-ups (explicitly out of scope for v1): per-launch detail
  page, "add as dip watcher" button (nice synergy — one click moves a
  graduated token into the existing watch flow), v2 curve feed.

### Deployment

- Add to `ecosystem.config.cjs` as `pons-poller` (cron-style restart not
  needed; the process loops internally).
- `npm start` / `npm run stop` keep working for all three processes.

## Signal scan: $15–20K market cap, low bot activity (phase 1.5)

Goal: surface launches in the **$15–20K market-cap band** whose activity
looks **organic** — few/no bot wallets. Not sure-things, just a filter: a
token that passes these checks is *worth a look*, nothing more.

### Why this band is interesting

Pons v2 graduation threshold is 4.2 ETH of paired principal (~$15–20K
depending on ETH price). So tokens sitting at $15–20K MC are (a) still on
the curve near graduation, or (b) just-graduated with a fresh locked V4
pool — the moment real price discovery starts. It's also small enough that
pure bot volume can't hide: with an MC that low, wash trading is a large
fraction of all activity and shows up clearly in the event stream.

### Data plumbing

- **Candidate set**: poller already stores `market_cap_usd` — the scan pass
  just selects rows in band. Cheap: only a handful of tokens qualify at any
  moment (vs 20K/day launches).
- **Trade stream per candidate**: on-chain events are the gold source.
  - v2 curve tokens: `CurveBuy`/`CurveSell` events from the token's curve
    (curve address comes from the launch feed / `TokenLaunched` output).
    Each event gives buyer/seller, quoteIn/tokensOut, block, timestamp.
  - v1 pool tokens: `Swap` events from the pool address.
  - Bounded scan: last ~500 events or 24h, whichever hits first, via viem
    `getLogs` on the Robinhood RPC we already use.
- **Funding graph**: for each trader address seen, one
  `alchemy_getAssetTransfers` call (ETH in, first acquisition) — same
  helper pattern as wallet-position.mjs. Cluster traders by funding parent.
- **Holder snapshot** (optional, phase 2): full `Transfer` event index per
  token is expensive; start with unique-active-wallet counts from the trade
  stream and add a real holder count (excluding the Pons locker
  `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` and v1 locker
  `0x736D76699C26D0d966744cAe304C000d471f7F35`) only for tokens that pass
  the first filter. Bitquery's holder API is the paid shortcut if RPC
  scanning proves too slow.

### Detection signals → bot score (0–100)

| # | Signal | How to compute | Weight |
|---|--------|----------------|--------|
| 1 | **Round-trip churn** | Wallets that both bought and sold ≥3 times within 24h (same address on both sides of the trade stream) | 30 |
| 2 | **Wallet-to-txn ratio** | unique traders vs total trades; >10 txn/wallet = suspicious, >25 = bot | 15 |
| 3 | **Funding-graph cluster** | ≥5 trader wallets funded by the same parent within a 10-min window | 25 |
| 4 | **Timing regularity** | stdev of inter-trade gaps < 10% of mean (script-loop cadence) | 10 |
| 5 | **Size uniformity** | >80% of trades within ±2% of the same size (wei-exact grids) | 10 |
| 6 | **Wash signature** | 24h volume > 3× MC with price change < ±5% and buys ≈ sells in count+size | 5 |
| 7 | **Snipe-window burst** | ≥3 distinct wallets buying in the first-5s 99%-tax window (v2 `currentSnipeTaxBps` era) — flags operator wallets, which then feed check #1 | 5 |

Score ≥ 60 → "high" bot risk (filtered out by default); 30–59 → "medium";
< 30 → "low". Scores decay: recompute on every poller pass while the token
is in band (in the band, that's cheap — maybe a dozen tokens).

### Storage

Add columns (ensureColumn pattern):

```sql
bot_score INTEGER, bot_risk TEXT,            -- low | medium | high
unique_wallets_24h INTEGER, trades_24h INTEGER,
round_trippers_24h INTEGER, funding_clusters INTEGER,
scan_window_from TEXT, scan_window_to TEXT
```

### Dashboard integration

- Default view of `/launches`: **"Signals" tab** — tokens in the $15–20K
  band, sorted by bot score ascending, showing unique wallets, round-trip
  count, funding clusters, and the risk pill. Tokens never scanned yet show
  a "pending scan" pill.
- The scan pass runs inside the poller on its own cadence (every ~10 min,
  only for in-band candidates) so it costs almost nothing at idle.

### Honest limits

- A patient operator with fresh funded wallets, human-lumpy timing, and
  varied sizes beats every heuristic here. This filter kills lazy bots,
  which is most of them — it is not an audit.
- Round-tripping has a benign form (market makers / quick scalpers). The
  score reports activity shape, not intent; read it as "how bot-like",
  never "is this token good".
- ETH price moves shift what $15–20K MC means for graduation; the band is
  a market-cap band, not a graduation band, and that's fine.

## Risks / notes

- **Firehose**: 20K launches/day means the "newest" list is noise. The
  useful default sort is `recentBuys` with a 24h window; make that the
  page default, not `newest`.
- **API is third-party**: ponsfamily.com could rate-limit or change shape.
  The poller must validate row shape defensively and log-and-skip bad rows.
  The on-chain indexer (phase 2) is the trust-minimized fallback.
- **IPFS logos**: gateway flakiness — render with `onerror` fallback to a
  generated letter-avatar (the dashboard already has an icon pipeline for
  chains/tokens; reuse `/api/icon` if cheap).
- **Not financial tooling**: graduation ≠ quality (their own docs say so).
  Keep the page descriptive; any "buy" action stays manual via existing flows.

## Build order (when approved)

1. `pons_launches` table + db functions + a one-shot backfill script
   (`scripts/pons-backfill.mjs`) — verifiable from the CLI alone.
2. Poller process + PM2 entry.
3. `/launches` page + nav link (basic: newest / recent buys / graduated).
4. Signal scan (phase 1.5 above): bot-score columns, per-candidate event
   scan, "Signals" tab with the $15–20K band view.
5. `hermes verify` + a live screenshot pass; record evidence.
