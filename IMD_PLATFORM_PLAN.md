# IMD_PLATFORM_PLAN.md — Standalone "IMD Launchpad Terminal"

Status: research doc + product plan · 2026-09-13
Source work: live session investigating `communitycoins.imd.fun` (docs + on-chain probes)
against the `/accumulate` codebase. All on-chain numbers below were read directly from
Ethereum mainnet (Alchemy RPC) or Dexscreener on 2026-09-13 unless marked otherwise.

---

## 1. The product

A **standalone app** — a fork/slim-down of the `/accumulate` codebase — that keeps the
product surface (Accumulate, **Alpha**, Sniper, MM, Zooch AI, Settings, Statistics) but is
rebuilt around **one platform**: the IMD Community Coins launchpad on Ethereum mainnet.

- **No Base. No Robinhood (4663).** Single chain, hardcoded: Ethereum mainnet.
- The platform is **pre-launch and just getting started**. The bet: purpose-built
  tooling for this launchpad (curve-aware, not pool-aware) has no competition, and the
  platform's design funnels all volume through one token (IMD), so every module — even
  coin trading — is ultimately a bet on IMD.
- Everything that made `/accumulate` work transfers: the safety gates, the ledger
  discipline, the honeypot probe, the bigint-safe dashboard, the dry-run-first
  execution paths. What changes is the *market model* underneath: these coins are not
  AMM positions, they are **bonding-curve positions**.

### Why a platform-specific tool is a real product here

Standard tooling (Rabby, routers, our own dip-watcher, Dexscreener-based venue
discovery) **does not work** on this platform — verified live, see §3.3:

- Wallets can't quote curve swaps (quoters revert; there is no AMM liquidity).
- Liquidity does not sit in pools; it sits in the curve (ERC-6909 claims in the
  PoolManager, owned by the hook).
- The interesting numbers (backing, curve position, burn rate, launchpad-wide IMD
  flow) are not displayed by ANY existing dashboard — only the launchpad's own pages,
  one coin at a time.

A terminal that shows the whole board + does safe execution + accumulates IMD is a
genuine first-mover position while the platform is small.

---

## 2. The platform — how it actually works

Full docs: `https://communitycoins.imd.fun/docs` (client-rendered; fetch via browser).

### 2.1 Architecture

Every coin is a **bonding curve denominated in IMD**. There is no order book, no LP,
no per-coin liquidity pool. Price is a pure function of coins sold.

```
trader --ETH--> [ ETH/IMD V4 pool, real liquidity, 1% fee tier ]
                       |
                      IMD
                       v
              [ coin's bonding curve  k = virtualImd x virtualCoin ]
```

- A coin's **"Uniswap V4 pool" exists but holds zero liquidity** — its hook's
  `beforeSwap` consumes the swap whole; both legs (ETH→IMD in the shared pool,
  IMD→coin on the curve) settle inside ONE PoolManager unlock. A swap either fully
  completes or reverts — it can never half-fill.
- The coin's entire 1B supply sits in the PoolManager as **ERC-6909 claims owned by
  the hook**; IMD backing accumulates per coin. Backing == virtualImd − launch
  virtualImd, exactly, at every point (invariant the curve guarantees).
- Coins are priced in IMD, so **buying any coin buys IMD** through the shared pool and
  lifts the whole board; selling any coin marks the whole board down. All coins are
  one correlated position.
- The coin's exit depth is bounded by the ETH/IMD pool's depth (all exits pass
  through it). Backing, not market cap, is what exits are paid from.

### 2.2 Verified contracts (Ethereum mainnet)

| Role | Address |
|---|---|
| Launchpad hook (curves, reserves, fees) | `0x51768F5dA32BA2008304cC81674da51aCb802888` |
| Factory (`launch()`, permissionless) | `0x73d1ae084F04f793A5bbd6B623d74400C9Fc3f42` |
| IMD token (the reserve asset) | `0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7` |
| Burn executor (0.5% IMD burn fee) | `0xe29386719C155B6847aD5a4E97C6674f10ffc750` |
| V4 PoolManager (canonical) | `0x000000000004444c5dc75cB358380D2e3dE08A90` |
| V4 Universal Router (canonical) | `0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af` |
| V4 StateView (canonical) | `0x7ffe42c4a5deea5b0fec41c94c136cf136cf115597227` |
| V4 Quoter (canonical) | `0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203` |

Curve pools (the coins): poolKey = `(currency0 = native ETH (0x0), currency1 = coin,
fee = 60, tickSpacing = 1, hooks = 0x51768F...02888)`. These poolKeys are **NOT
initialized as AMM pools** on the canonical PoolManager (StateView slot0/liquidity all
zero — verified for two coins). Read curve state from the **hook**, not StateView.

### 2.3 Fees (per curve swap)

| Fee | Recipient |
|---|---|
| 1% | ETH/IMD pool LPs (+ Uniswap protocol fee on top) |
| 0.5% of the ETH leg | coin creator, paid out every trade |
| 0.5% of the IMD leg | **burned** (permanent IMD supply reduction) |

≈ 2%+ all-in to trade a coin on the curve. Direct IMD/ETH pool trades pay only the
1% pool fee (no creator fee, no burn — they don't touch the launchpad path).

### 2.4 IMD market snapshot (2026-09-13)

- IMD/ETH V4 pool `0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3`
  (1% fee tier, tickSpacing 200): price **$2.80**, liquidity **$1.45M**, 24h volume
  **$212k**, 295 txns, mcap ~$9.4M, +10% on the day. Realized vol (28 daily candles):
  **22.4%/day** — 16 of 27 days moved ≥5%.
- Secondary IMD/ETH pool also seen in Dexscreener search: ~$178k liquidity (venue
  ambiguity to resolve before arming anything — set `pool_address` override).
- Turnover ≈ 0.15× liquidity/day. Fees to LPs ≈ $2.1k/day ≈ ~53% APR *if volume holds*.

---

## 3. Research findings (what this session established)

### 3.1 The wallet-quote mystery — SOLVED

Raw txs provided by the user, decoded with viem:

- UR calldata: `execute(bytes,bytes[],uint256)` (selector `0x3593564c`), commands
  `0x060c0f` = SWAP_EXACT_IN_SINGLE → SETTLE_ALL → TAKE_ALL (same command shape our
  `sendV4Buy()` already emits for ordinary pools).
- **hookData = the recipient wallet address** (32 bytes) — a launchpad-specific
  parameter that generic routers never populate.
- Completed tx (coinB `0xe56b29e2...`, 0.005 ETH in): succeeded with this shape.
  Rabby tx (BALLOON `0xa2cc24e8...`, 0.01 ETH in, minOut 417,917 tokens): no quote.

**Why Rabby fails**: the canonical V4 Quoter **reverts** on curve poolKeys (verified:
`quoteExactInputSingle` reverts for both coins, with empty AND wallet hookData), and
the curve pools have zero AMM liquidity to quote against. The launchpad UI quotes from
curve math locally and fabricates correct hookData. **Implication for the product: our
own execution paths cannot use quoters for coin trades either — we must mirror the
curve (or read the hook) and emit UR calldata with hookData = recipient wallet.**

### 3.2 Supply/backing is verifiable on-chain

ERC-6909 claims of the hook, read from the PoolManager:

- BALLOON (`0xa2cc24e8...`): 1B supply; hook holds **577.2M (57.7%)** → ~42% sold;
  curve backing exists and is computable per coin.
- coinB (`0xe56b29e2...`): hook holds **999.4M** → essentially untouched launch.

### 3.3 The only real secondary pool — and the arb

Dexscreener pair endpoint identified pool `0x743a2c8b972e6631363d15b56cf5cffc900e536dc659502cda67369986f21c90`:

| Field | Value |
|---|---|
| Pair | **BALLOON / USDC** (V4, manually seeded secondary pool — NOT launchpad infra) |
| Liquidity | **$6,383** |
| 24h volume | **$11.82** (1 sell txn) |
| Created | ~2026-08-18 |
| slot0 | tick 374270, live liquidity (L = 6.54e16) on canonical PoolManager |

Pool price $0.0000558 vs curve-implied ~$0.0000598 → ~7% gross / ~5% net (after ~2%
launchpad fees) arb. On $6.4k of depth the total extractable is **~$100–300, one-shot**.
Real but not a strategy at current size.

### 3.4 MM viability verdict (the decision that shaped this plan)

- **Launchpad coins: NOT MM-able.** No order book, no LP, no counterparty. Price is a
  function of coins sold. Any "MM" on a coin is just trading the curve, paying ~2%
  fees per round trip to do it.
- **The one real secondary pool (BALLOON/USDC): NOT viable.** $12/day of volume
  doesn't cover one round trip of gas; `min_external_txns=2` per 15-min window will
  never pass; the engine's own gates idle the bot 100% of the time. This was checked
  against `mm-engine.decideTrade` gates directly, not vibes.
- **IMD/ETH pool: the only MM-able market in the system** — and it's a marginal one:
  ±1–2% band around a 2h fair-value EMA, ~2% fee hurdle per round trip, 22%/day vol
  (crosses the band often, but much of it is trend, not mean reversion — the SIRIUS
  lesson: band bots buy dips in downtrends).
- **Strategic conclusion**: if the goal is owning lots of IMD, a two-sided MM bot is
  the wrong machine (alternation gate forces you to sell what you want to keep). The
  accumulator is the right machine; LPing the IMD/ETH pool is a yield overlay (~53%
  APR at current volume) that mutates IMD upside; MM on IMD/ETH is optional,
  small-size, and secondary.

### 3.5 Corrections recorded during research

- `chains.mjs` mainnet StateView address (`...cf115597227`) is **correct** — a "latent
  bug" flagged mid-session was the researcher's own typo (checksummed variant failed;
  lowercase works). Do not "fix" it.
- Full-range mainnet log scans via drpc/publicnode returned false "not found" results;
  Alchemy free tier caps eth_getLogs at 10 blocks on mainnet too. **Pool→poolKey
  discovery on mainnet needs a paid key, The Graph, or hook-event subscription.**

---

## 4. Product plan — module by module

Codebase strategy: fork `/accumulate`, delete the `chain` dimension (hardcode mainnet),
replace pool-quoter plumbing for coin trades with curve plumbing. Keep db patterns
(`ensureColumn`), the ledger discipline, bigint-safe `json()`, dry-run-first paths,
and the honeypot probe verbatim.

### 4.1 Alpha (retooled — launchpad-native discovery)

The existing `alpha-engine.mjs` is a three-provider architecture whose contract is
exactly right for this platform: on-chain discovery → market-data enrichment →
scored queue with security badges. What changes is the middle of the pipeline —
the launchpad's structure makes most of the Robinhood providers dead weight and
adds curve-native data nothing else can show:

**Keep as-is (the parts that transfer verbatim):**

- `tokenScore()` / `marketTokenScore()` heuristics (buy-pressure, unique buyers,
  volume, freshness, cap-sweet-spot) — they consume generic `{buys, sells,
  uniqueBuyers, quoteVolume, ageSec}` and work on curve trades unchanged.
- The scored-queue shape: `data.alpha` (score, kind, protocol, security, age),
  `alphaVisible()` security filtering (closed-source/honeypot tokens never
  displayed — the OPAI lesson), the JSON cache + hydrate-on-restart pattern,
  429 backoff, per-tick segment caps, debounced `recompute()`.
- GoPlus security (change chain id `4663` → `1` in the URL — mainnet is GoPlus's
  best-covered chain).
- The dedupe/merge of on-chain launches with market data.

**Replace — discovery (the launchpad is not PONS):**

| Old (Robinhood) | New (IMD launchpad) |
|---|---|
| PONS factory `Launch` events | Factory `0x73d1ae08...` `launch()` events (topic to be derived from the verified contract ABI — one event per coin) |
| PONS curve Buy/Sell topics | PoolManager Swap logs filtered by each coin's curve poolId (the signed-amount decode from `mm-watcher.getExternalFlow` is the reference implementation) |
| LONG hook classification | Delete — no analog |
| STONK executor scraping | Delete — no analog |
| Public RPC full-range scans | **Blocker**: mainnet Alchemy free tier caps `eth_getLogs` at 10 blocks (verified this session). Discovery needs a paid Alchemy tier OR a Graph subscription on the launchpad/hook. Decide before building; without one, discovery degrades to polling the launchpad's own board API (it serves the coin list to its own frontend) with on-chain verification of everything shown. |

**Replace — enrichment (DexScreener is no longer the primary):**

- Primary enrichment = **hook contract reads** (curve reserves, coins sold,
  backing, virtual IMD) — this is the launchpad-native data no other tool shows.
  Batched multicall per poll tick.
- DexScreener drops to a secondary role: secondary-pool detection only (the
  BALLOON/USDC case — a coin with a real V4/V3 pool someone seeded). The queue
  flags "curve-pool spread: +5%" rows when secondary liquidity exists; that flag
  is also the future arb feed (§4.6).
- Price: curve price is computed from reserves (deterministic), not scraped.
  USD via Chainlink ETH × ETH/IMD pool.

**New columns the launchpad makes possible** (Board-tab §4.3 shares this row
renderer): coins sold %, backing vs mcap (the "exit honesty" ratio), curve
buyers 24h (unique wallets from Swap logs), creator fee accrual, age, and the
verify-sellable badge from the Sniper's probe (`verified_at`/`verified_via` —
launch provenance badges everywhere, DexScreener paid-placement lesson).

**New scoring signal**: IMD-flow share — a coin whose curve buys are pulling
IMD through the shared pool is lifting the whole board; weight recent unique
buyers on the curve higher than raw USD volume (curve volume is ~2%-fee-clipped
and tiny in the platform's early days; buyer counts are the better health
signal — the `uniqueBuyers` term already dominates `tokenScore`, so this is
mostly a weights pass once real data flows).

**Filters/UI**: replace the `graduated/all` source filter with
`on-curve / has-secondary-pool / all`, and the $10K-default volume filter with
platform-appropriate defaults (24h vol ≥ $500 default, or coins-sold ≥ 1%).
Keep min-score/liquidity seg-buttons. Snipe button links to
`/sniper?token=…` unchanged.

### 4.3 Board (new tab — the platform's home screen)

The product's differentiator. Launchpad-wide view, one row per coin, plus IMD
header. **Shares the Alpha engine's data layer** (§4.1) — same discovery, same
hook reads, same row renderer — but presented as the platform overview: every
coin, always, no score gate.

- IMD header card: price, 24h vol, ETH/IMD pool depth, burn tally (read burn executor
  + total supply over time), estimated fee flow into LPs, board-wide 24h flow.
- Per coin: price (from curve), coins sold %, backing (USD + IMD), virtual reserves,
  creator fee accrual, age, hook-held supply %, "curves vs secondary pool" spread when
  a secondary pool exists (the arb flag), holder-adjacent evidence from swap logs.
- Data sources: hook contract reads (curves/reserves), factory `launch()` events for
  discovery, PoolManager Swap logs for flow, Dexscreener for secondary pools.
- No free holder index — narrative shows "holders unavailable", never invented.

### 4.4 Accumulate

Two accumulation targets, both first-class:

- **IMD itself** (the default thesis): scheduled + dip buys on the real IMD/ETH V4
  pool. Keep `accumulation_strategies` semantics, Zooch-style clamps, budget
  reservation, auto-pause on budget exhaustion. Chain = mainnet; price via Chainlink.
- **Launchpad coins** (optional per-coin plans): accumulate a coin through its CURVE
  (buy = UR V4_SWAP with hookData = our wallet), cost basis in USD via Chainlink ETH.
  Budget/scheduling logic identical; execution path is curve, not quoter.
- Sell path: curve sells pay from backing; keep the ≥50%-of-fair-value proceeds guard.

### 4.5 Sniper

Rebuilt for launches (the platform's core loop):

- **Discovery**: factory `launch()` events (every coin is a permissionless
  `launch()` — same paid-placement caveat as the DexScreener lesson; everything is
  provenance-unverified until a sell probe passes). Ticker squatters guaranteed —
  identify by contract address only.
- **Buy**: small live probe buy through the curve (UR + hookData = wallet). Since
  quoters revert, expected-out is computed from curve math; slippage guard compares
  realized vs curve-computed.
- **Honeypot guard is MORE critical here, not less** (OPAI lesson transfers verbatim:
  hooks can tax sells ~100%; a successful receipt proves nothing). Keep the empirical
  sell probe (buy $1 → sell → quote-asset balance delta ≥50%), exit auto-pause,
  autosell-arm refusal, VERIFY FAILED ledger rows. The quote asset for delta checks is
  **IMD**, not USDG/ETH.
- **Verify-sellable badge** persisted per coin (`verified_at`/`verified_via`).

### 4.6 MM

Repositioned honestly (see §3.4):

- **IMD/ETH pool**: the only supported MM venue. Small clips, 2h fair-value EMA,
  alternation + external-flow gates (real Swap-log USD flow, own-tx exclusion via
  hash-join) — all of `mm-engine` transfers as-is with chain hardcoded.
- **Curve↔pool arb (new, opportunistic)**: when a coin has a real secondary pool
  (threshold: ≥$25k liquidity AND ≥$2k/day volume — BALLOON today is 40× below this),
  buy on the cheaper venue, sell into the other, net of ~2% curve fees + pool fees.
  Start manual (one-click arb rows on the Board), automate only after dry-run
  evidence.
- MM on launchpad coins: **removed**, with a UI note explaining why (no market).

### 4.7 Zooch AI

Same planner shape (one Venice call → clamped plan + narrative), new evidence set:

- **Curve evidence** (unique, no other tool has it): coins-sold %, backing vs mcap
  gap, recent curve flow (buys/sells USD), board-wide IMD flow correlation.
- IMD plans: standard technicals (GeckoTerminal daily OHLCV — supported on eth),
  Dexscreener venue snapshot for the ETH/IMD pool, The Graph per-trade sell sizes
  (Graph Studio key) to set `dipThresholdUsd`.
- Coin plans: curve position (early = explosive upside, exit depth = ETH/IMD pool
  depth), fee drag (~2%), honeypot-verification status.
- Keep: hard clamps (`normalizeAiProposal`), `validateZoochProposal`, heuristic
  fallback, advisory-until-apply, `dipThresholdUsd`-is-a-dollar warning.

### 4.8 Statistics

- Trade ledger (keep every lesson: realized vs unrealized split, exit proceeds via
  balance-delta `getTxDeliveredEth`, dip rows carry the WHALE's tx hash, gas
  breakdown excluding whale gas, budget-exhaustion auto-pause rows).
- Platform stats tab (new): IMD burn cumulative + rate, launchpad volume vs IMD price
  (the flywheel, charted), board breadth (coins launched / active / with backing),
  our share of volume.
- Gas ledger: mainnet gas is ~10-50× Robinhood's — every module's trade-size defaults
  need re-tuning so fees don't eat clips (SIRIUS thin-LP lesson now applies to IMD
  pool trades too).

### 4.9 Settings

- Strip chain selection. Mainnet only; Alchemy mainnet key (WebSocket for
  dip-watcher), signer (raw key or VultiSig — VultiSig supports Ethereum), Venice key
  for Zooch, optional The Graph Studio key.
- **Paid-key note**: mainnet eth_getLogs on Alchemy free tier is capped at 10 blocks —
  the Board/Sniper discovery paths need either a paid Alchemy tier or Graph
  subscriptions. Decide before launch; this is the one real infra dependency.

---

## 5. Risks

- **Correlated systemic risk**: all coins are one position (IMD). Board-wide selloffs
  compound through the shared pool. Any portfolio view must show net IMD exposure
  across coins + IMD itself, not per-coin rows.
- **Exit depth ceiling**: every exit runs through ETH/IMD ($1.45M). Accumulation
  sized beyond low single-digit % of that pool cannot exit without moving price
  against itself. The Board should show "our position as % of exit depth" on every row.
- **Platform immaturity**: volume is tiny ($212k/day IMD, $12/day on the best
  secondary pool). The product must be useful as a *watch/accumulate* terminal on day
  one and earn its execution features as liquidity grows. Don't build for a market
  that doesn't exist yet (the BALLOON/USDC MM lesson).
- **Permissionless launches**: every coin is a scam candidate until a sell probe
  passes; the UI must never present unverified coins as safe (DexScreener paid-
  placement lesson: provenance badges everywhere).
- **Fee drag**: ~2% curve round trips + 1% IMD pool fee set a high hurdle for any
  high-frequency strategy; small-frequent-clips only, and only where flow justifies it.
- **Quoter-free execution** is bespoke code with real money on the other side: every
  new calldata path goes through `eth_estimateGas` dry-run → small live buy → arm,
  exactly per the existing hard-won-lessons rule.

---

## 6. Hosted deployment — Alchemy Smart Wallets (research item)

The current app's security model is "runs on your machine, key never leaves it."
A hosted version (users sign up through a browser, our server runs the watchers)
needs a key model that doesn't ask users to paste a private key into a web form.
**Alchemy Smart Wallets** (`account-kit.alchemy.com`) are the leading candidate —
research before committing.

### 6.1 What they are

ERC-4337 account-abstraction wallets, embedded via Alchemy's Account Kit SDK:

- **Passkey-keyed**: the user's signing credential is a WebAuthn passkey stored in
  their device's secure enclave — no seed phrase, no private key touching our
  servers at all. This dissolves the hosted-custody problem instead of solving it.
- **Session keys**: scoped, spend-capped, time-boxed signing policies. A user could
  arm the dip-watcher with a session key limited to, say, $50/day on one token
  address, and the browser could execute buys while they're away WITHOUT holding
  anything more than that. This maps almost 1:1 onto `accumulation_strategies`
  (budget → session-key spend cap; `end_at` → session expiry).
- **Gas sponsorship / paymaster**: we could sponsor gas for small trades (the
  ERC-4337 UserOperation pays from a paymaster). This directly attacks the
  mainnet-gas problem in §5 (gas eats small clips) — a hosted product could
  bundle/subsidize gas for sub-$100 plans, which no self-hosted install can do.
- **Batched calls**: one UserOperation can do WETH-wrap + approve + swap — though
  note the Robinhood WRAP lesson: batching doesn't fix broken calldata, verify per
  path.

### 6.2 Integration shape (if we proceed)

- `signer.mjs` gains a third backend beside raw key + VultiSig: an AA signer whose
  `callContract` submits a UserOperation through Alchemy's bundler instead of
  `eth_sendRawTransaction`. The unified-signer interface is exactly why this is
  cheap to add — every module already goes through it.
- **Curve trades via AA need a hook check first** (research item, potentially
  blocking): the launchpad hook's `beforeSwap` runs inside PoolManager's
  `unlockCall`. If it asserts `msg.sender` or the funds source, a UserOperation
  originating from the smart-account proxy contract (not an EOA) could revert.
  The completed tx we decoded went UR ← EOA. Must dry-run the same calldata from
  an AA sender before building anything on this.
- **The Sniper's honeypot probe is AA-compatible in principle** (it's just swaps
  + balance reads) but the 1–2 min receipt-wait needs rethinking under
  UserOperation lifecycle (mempool wait + bundle) — latency budget needs measuring.
- Keep **dry-run-first discipline**: `eth_estimateGas` has no direct AA analog;
  use `eth_estimateUserOperationGas` and the bundler's simulation before arming.

### 6.3 What to actually research (checklist)

1. **Does the launchpad hook accept UserOperations?** Dry-run the exact `0x060c0f`
   UR calldata from a fresh smart-account address via
   `eth_estimateUserOperationGas` on a coin curve + on the IMD/ETH pool. This is
   the go/no-go for everything below.
2. Fee model: Alchemy's gas-manager pricing vs the ~2% curve fee — sponsorship is
   only viable if we don't double-charge; decide who pays gas in the hosted model
   (user via passkey signature is the default; sponsorship is a growth lever).
3. Session-key spend limits granularity: per-token? per-strategy? Can the cap be
   updated server-side without a new passkey ceremony (probably not — that's a
   feature, not a bug, but confirm the UX cost)?
4. ERC-6909 claims: smart accounts holding coins via the PoolManager — are there
   any non-standard `transferFrom` paths in exit flows that AA wallets handle
   differently (the wallet-position/balance-delta code reads `balanceOf` — should
   work, but verify against a live AA account)?
5. Custody/compliance posture for a hosted product holding user trading authority
   (even passkey-scoped): terms-of-service, jurisdiction, whether the product is
   "non-custodial" in the sense users expect given session keys.
6. Fallback: if the hook blocks AA senders, the fallback is Alchemy's **embedded
   EOA wallets** (key-sharding, non-AA) — worse security story, same UX, worth
   pricing as plan B. Second fallback: user-supplied keys with the existing
   masked-preview Settings flow over an authenticated hosted session (what we
   have today, just web-hosted).

**Verdict to reach**: hosted-with-passkeys is the difference between "a tool for
us" and "a product for the launchpad's users" — but it's gated entirely on
research item 1. No code until that dry-run passes.

### 6.4 Access token — a launchpad coin gates the hosted app

The hosted version's access control starts as a **token launch on the IMD
platform itself**: create our own coin via the factory's permissionless
`launch()`, and gate the app behind a simple wallet check — connected wallet
holds ≥ `MIN_BALANCE` of our coin, else read-only mode.

Why launch on the platform rather than deploy a standalone ERC-20:

- **Dogfooding is the marketing.** Every user of the hosted app is, by
  construction, an IMD-platform user; launching our access coin there means it
  shows up on the Board we're also building, gets discovered by our own Alpha
  queue, and its curve flow is visible in our own Statistics. The product
  advertises itself.
- **The curve is the funding model.** Launchpad buys route through the ETH/IMD
  pool and pay the standard fee stack (1% LP + 0.5% creator — to us — + 0.5%
  burn). Every seat purchased accrues the creator fee to the deployment wallet.
- **Alignment**: holding the access token = holding a curve position whose
  backing grows with adoption. Access and incentive point the same way. (This
  is also the risk — see below.)

**The gate itself (v1 — deliberately simple):**

```
signin:  connect wallet (or AA account per §6.1)
check:   balanceOf(wallet, ACCESS_TOKEN) >= MIN_BALANCE   // read-only eth_call
session: signed SIWE-style message "I hold access" + timestamp,
         re-checked server-side every N hours
fail:    full UI visible, all execution routes 403 — read-only mode
```

- No token-gated backend accounts, no allowlist DB in v1 — the chain is the
  allowlist. `MIN_BALANCE` is a single server env/config value; raising it
  takes effect on next re-check.
- The check must read the coin's **curve position**, not an ERC-20 balance
  guess: coin holdings live as ERC-6909 claims in the PoolManager (verified
  this session — the hook holds the supply). The balance read is
  `balanceOf(PoolManager-holder mapping)` per the hook's accounting — same read
  layer the Board tab already builds, so the gate reuses §4.1 code.
- AA accounts (§6.1) pass the same check — `balanceOf` on the smart-account
  address works identically.

**Known costs, stated up front:**

- **Selling the token = losing access, by design.** Users exit by selling on
  the curve, paying the ~2% fee stack. That's the alignment mechanism working;
  the pricing of `MIN_BALANCE` should reflect it (start low).
- **Curve exit depth applies to us too**: user exits are paid from backing, and
  our creator-fee accrual is IMD, not ETH. Fine at small scale; revisit if the
  hosted user base grows past the curve's comfortable exit size.
- **Not a security boundary.** The gate is for monetization/access control, not
  custody isolation — each user's funds remain in their own (smart) wallet; our
  server can't move user funds even for token holders. Say this in the ToS.
- **Ticker/name squatters will appear** (they always do) — publish the contract
  address in the app UI and verify by address, never by symbol (existing
  ticker-squatter lesson).
- Upgrade path (post-v1, only if needed): time-weighted balances, tiered
  `MIN_BALANCE` for higher rate limits, or NFT receipts instead of min-balance.
  None of it changes the v1 shape.

**Build order note**: the token can be launched the day the standalone app's
Board/Alpha stack can display it (§7 step 1) — it costs one `launch()` call and
a `balanceOf` gate middleware on the hosted server. Nothing else in this plan
depends on it, so it can ride along whenever hosted (§6) firms up.

---

## 7. Suggested build order

1. Alpha (retooled: launchpad discovery + hook-read enrichment) + Board (read-only)
   on the same data layer — zero risk, immediate differentiator.
2. Settings/chain-strip + IMD accumulate on ETH/IMD pool (existing machinery, new venue).
3. Sniper for launches (probe buy + sell probe + ledger) with manual-arming only.
4. Statistics platform tab + burn tracker.
5. Zooch evidence adapters (curve evidence) + coin accumulation plans.
6. MM on IMD/ETH (small, dry-run-first) + one-click arb rows when secondary pools exist.
7. **Hosted track (parallel, research-gated)**: run the §6 checklist — the AA dry-run
   (item 1) can start immediately since it needs no product code. If it passes,
   smart-wallet onboarding becomes the hosted product's spine; if it fails, decide
   between embedded-EOA fallback and shipping self-hosted only.
8. **Access token**: launch our own coin on the platform (one `launch()` call, §6.4)
   once step 1's Board/Alpha stack can display it, then gate the hosted app behind
   the min-balance wallet check. Independent of the AA decision — the gate works
   identically for EOA and smart-account users.
