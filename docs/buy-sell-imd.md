# Buying and Selling IMD — as-built reference

**IMD token**: `0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7` (18 decimals, Ethereum mainnet)

> **Identify by contract address only.** Ticker squatters are guaranteed on this
> launchpad's board; never resolve trades by symbol.

## What IMD is (and isn't)

IMD is the **reserve asset** of the IMD Community Coins launchpad — it is **NOT a
curve/launchpad token itself** (confirmed 2026-09-23; the curve branch in every
execution path must never engage for it). It is a plain ERC-20 with real AMM
liquidity on Uniswap V4 and V3. The launchpad *coins* (bonding-curve tokens
denominated in IMD) are a separate asset class — see `CLAUDE.md` § Alpha tab and
`curve-buy.mjs` for those.

Practical consequence: every sell path for IMD is a **standard AMM route**. The
launchpad-coin exemptions (trusted, no honeypot probe) still apply because the
token comes from this ecosystem, but the curve machinery does not apply.

## The pools (venue ambiguity is real — always check)

| Venue | ID / address | fee / tickSpacing | hooks | liquidity (approx, 2026-09-23) |
|---|---|---|---|---|
| V4 ETH/IMD | poolId `0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3` | 10000 / 200 | none | ~$1.76M |
| V4 ETH/IMD (hooked) | poolId `0x415829f72e9f54531c26eae76f107618540e898a45d6ae35959e143f5faca704` | 10000 / 60 | `0xC6C965BD164C483E87D0B550671798E9A3602840` | the pool the Uniswap UI trades |
| V3 USDC/IMD | `0x894D…` (fee 3000) | 3000 | — | ~$33k |

- **Two V4 pools with the same fee tier exist.** The hooked one is where UI
  volume flows. Always resolve the poolKey from Initialize logs / StateView —
  never assume which pool a price source is quoting.
- The V4 quoter prices sells in BOTH directions on the `b07d` pool (verified
  live 2026-09-22), but **quoter success does not mean router success** — see
  the sell section.

## Allowances (user EOA `0xa71F…75Cb`, verified 2026-09-23)

| Token | Spender | Status |
|---|---|---|
| IMD | SwapRouter02 (`0x68b3…Fc45`) | MAX ✓ |
| IMD | Permit2 (`0x0000…78BA3`) | huge (1.46e33) ✓ |
| IMD | hook-router (`0x2361…DE85`) | via per-trade Permit2 permit, signed per trade |

## HOW TO BUY (proven live)

### Native-ETH buy — V3 (SwapRouter02)

```
multicall([exactInputSingle(tokenOut=IMD, recipient=wallet), refundETH])
```
with `msg.value` attached. **Never pre-wrap ETH** — after an explicit
`wrapETH` the router's ETH balance is 0 and its swap callback pulls WETH from
the WALLET, reverting STF when the wallet holds none (verified live on Base via
`debug_traceCall`). Attach value; let the router wrap-and-pay; `refundETH`
returns the unused part. Code: `dip-swap.mjs` `buyDip()`.

### Native-ETH buy — V4 (Universal Router)

`buildV4ExactInPathPayload` (dip-swap.mjs) — the **only proven-correct V4 tuple
encoder in this codebase** (live-verified on buys):

```
execute("0x060c0f", [v4SwapInput], deadline)          # SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
v4SwapInput = 0x20 ++ [currencyIn=ETH][pathOff=0xa0][emptyOff=0x1a0]
                     [amountIn][minOut][1][0x20][token][fee][tickSpacing]
                     [hooks][0xa0][0][0]
```

The trailing empty dynamic field beyond `{currencyIn, path, amountIn,
amountOutMinimum}` is not in any published ABI fragment — it was recovered by
decoding Uniswap's own frontend calldata. `msg.value` pays; no Permit2 for the
ETH side.

### Dollar-quoted buy

V4 pools quoted in USDG/USDC: pre-flight **two** Permit2 layers (ERC-20 approve
of dollar→Permit2, then Permit2 `approve(dollar → UR, MAX, MAX_UINT48)`), then
the same `buildV4ExactInPathPayload` with `currencyIn = dollar`. Commands
`0x070b0e` (SWAP_EXACT_IN for the multi-hop-capable action — required on hooked
pools where SWAP_EXACT_IN_SINGLE reverts).

### What NOT to use for buys

- The V4 quoter **works** for IMD buys on `b07d` (both directions verified
  2026-09-23: `quoteSellV4` 2.118e-9 ETH per 1e-6 IMD, `quoteBuyV4` 4.6e14 IMD
  per 1e-6 ETH). Quote-level guards are fine here.
- Curve-coin machinery (`curve-buy.mjs`, `getCurveCoinState`) must never route
  IMD — it isn't a curve token.

## HOW TO SELL (current state)

### ✅ Works today: IMD → USDC via V3 (deployed, commit `f78a18b`)

`SwapRouter02.exactInputSingle` on the V3 USDC/IMD pool (fee 3000), delivered
as USDC to the seller. This is what the watcher exit now uses: `buildSellTx`
delegates to `executeSniperSell` → `resolveSellVenue`, which ranks
V4 / V3-dollar / V3-WETH candidates by liquidity, **quote-tests V4 candidates
and demotes ones whose quoter reverts**, and stages approve→swap via the
capture-signer (one browser signature per stage). Live-verified: 1 IMD → $5.95
USDC; full-balance `eth_call` simulation passed at the exact on-chain balance.

The standing caveat: IMD is a plain ERC-20, so **`Sell 100%` amounts must be
full-precision decimal STRINGS** (BigInt scale / `formatUnits`), never floats
(see CLAUDE.md float round-trip lesson — three independent live hits).

### ❌ What does NOT work (do not re-learn these)

1. **V4 sell through the Universal Router with a plain ERC-20 allowance
   reverts.** The ETH/IMD hooked pool's hook does not accept it. Even
   byte-perfect replays of swap-only calldata revert — the pool requires the
   per-trade Permit2 permit leg to run first in the same `execute`.
2. **`findBestV3DollarPool` liquidity saturation**: it reports ~$2B for the
   $33k USDC pool, which beats the V4 pool's real $1.76M in the venue ranking.
   Same bug affects dip-watcher venue selection. **Not yet fixed.**
3. **Replaying the UI's calldata against the UR fails** — because the UI does
   not use the UR for this pool (see below).

### 🎯 The proven IMD → ETH sell (on-chain ground truth, 2026-09-23)

Tx `0x6fbc31886fa6ccb50359c1b2f2822701823325bd3205d52127b0905e1535630d`
(block 26036791) — sold 1 IMD → ~0.00212 ETH, **from the user's EOA, succeeded**.

| Field | Value |
|---|---|
| **`to`** | `0x23617E59A5925B2A4BF75D73FF6711CD0B29DE85` — the **hook-router**, NOT the Universal Router |
| selector | `0x3593564c` = `execute(bytes commands, bytes[] inputs, uint256 deadline)` |
| commands | `0x0a10` (PERMIT2_PERMIT + V4_SWAP) |
| deadline | `0x6ab32cc4` |

**input[0] — PERMIT2_PERMIT** (per-trade permit; a plain ERC-20 allowance does
NOT satisfy this pool):

```
PermitSingle {
  details: { token: IMD, amount: MAX_UINT160, expiration: <far-future uint48>, nonce },
  spender: 0x23617E59A5925B2A4BF75D73FF6711CD0B29DE85,   # the hook-router, not the UR
  sigDeadline
} ++ 65-byte EIP-712 signature
```
EIP-712 domain: `{ name: "Permit2", chainId: 1, verifyingContract: Permit2 }` —
implemented as `permitTypedData()` in `v4-hook-sell.mjs`.

**input[1] — V4_SWAP** (`abi.encode(bytes actions, bytes[] params)`),
actions `0x070b0e` = SWAP_EXACT_IN, SETTLE_ALL, TAKE_ALL:

```
params[0] (swap) — 16 words / 512 bytes:
  [0x20]        tuple offset
  [IMD]         currencyIn (we sell the token)
  [0xa0]        path offset (HEAD_WORDS = 5 × 32)
  [0x1a0]       trailing-empty-field offset (pathOffset + 8 × 32)
  [amountIn] [minOut]
  [1] [0x20]    published member + its offset (same as the proven buy encoder)
  [ETH]         PathKey.intermediate = ETH (proceeds)
  [10000]       fee
  [60]          tickSpacing
  [0xC6C965BD…] hooks
  [0xa0]        hookData offset
  [0]           proven layout word
  [1]           hookDataLength = 1 word
  [0x689bab3f3a37da09d5932db10000]   ← word 16: NOT the seller (see below)

params[1] SETTLE_ALL: (currency=IMD, amount=0, payerIsUser=true)
params[2] TAKE_ALL:   (currency=ETH, recipient=SELLER, amount=0)
```

**Word 16 of the swap tuple is a mystery value, now resolved:** the earlier
session believed the pasted UI calldata was nibble-corrupted at that word and
that it held the seller address. The on-chain bytes (fetched clean via
`eth_getTransactionByHash`) prove the value really is
`0x…689bab3f3a37da09d5932db10000` — almost certainly a
**sqrtPriceLimitX96** for the swap (same scale as a price limit; the UI sets
one). The seller address appears **only** in the TAKE params as the recipient.

**Trailing bytes:** the tx calldata continues past the deadline with
`756e6978…` ("unix" + hex) — either a 4th argument of this contract's
`execute` or router-specific trailing data. Not yet decoded. If a dry-run
against `0x23617e59…` reverts, check this first.

### State of `v4-hook-sell.mjs` (uncommitted working tree)

Rebuilt 2026-09-23 with viem-native encoding; structural harness
(`scripts/verify-v4-hook-sell.mjs`) passes 33/33 words against the on-chain
bytes **except** the two known-wrong fields. Remaining fixes before it can
ship:

1. **Target `0x23617e59…`, not the UR** — `buildHookedPoolSellCalldata`
   currently returns the UR address.
2. **Word 16 = the price-limit value the UI used** (or `0` — test whether this
   contract accepts 0), not the seller address.
3. **Resolve the trailing calldata bytes** after the deadline.
4. Then: dry-run `eth_estimateGas` against `0x23617e59…` (should simulate clean
   — every earlier "unknown reason" revert was against the wrong router), one
   small live sell (~$1), then arm.

## Verification ladder (every new execution path)

1. **Structural**: `node scripts/verify-v4-hook-sell.mjs` — viem-decode our
   calldata and diff every word against the on-chain ground truth
   (`/tmp/v4-sell-tx.json`; re-fetch with `scripts/fetch-ui-sell-tx.mjs`).
2. **Dry-run**: `eth_estimateGas` / `eth_call` of the exact calldata as the
   seller. Against `0x23617e59…`, not the UR.
3. **Small live sell** (~$1 of IMD), verify delivered ETH via
   `getTxDeliveredEth` (balance-delta, not `msg.value`).
4. **Arm.**

## Signed-amount decode reminder (dip detection)

Swap event amounts are SIGNED ints — decode two's complement. Token side
negative ⇒ external BUY; positive ⇒ external SELL. The watcher's venue choice
for IMD must point at the pool IMD actually trades (the hooked pool sees the UI
flow); the `findBestV3DollarPool` saturation bug currently distorts this — fix
alongside the sell work.

## Related code

| File | Role |
|---|---|
| `dip-swap.mjs` | Proven buy encoders: `buildV4ExactInPathPayload`, `sendV4Buy`, `buyDipWithDollar` (Permit2 two-layer pre-flight) |
| `v4-hook-sell.mjs` | IMD→ETH hooked-pool sell builder (needs the 3 fixes above) |
| `scripts/verify-v4-hook-sell.mjs` | Structural diff harness vs on-chain ground truth |
| `scripts/fetch-ui-sell-tx.mjs` | Re-fetch the reference sell tx calldata |
| `sniper-extras.mjs` | `resolveSellVenue` / `executeSniperSell` / `executeV3DollarSell` (the working USDC path) |
| `direct-sell.mjs` | Capture-signer builders (watcher exit + sniper sell share one dispatcher) |
