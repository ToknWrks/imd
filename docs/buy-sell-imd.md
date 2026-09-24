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

## HOW TO SELL — IMD → ETH only (as-built 2026-09-24)

**One path for every IMD sell** (manual Exit in autonomy and co-pilot, sniper,
autosell): `executeSniperSell` short-circuits IMD to
`executeImdEthSell()` in `v4-hook-sell.mjs`. **IMD never sells to USDC** and
never goes through the Universal Router. The Exit modal has no proceeds
toggle anymore — IMD exits pay ETH.

- **Target:** hook-router `0x23617e59…De85` — `execute("0x10", [V4_SWAP], deadline)`.
- **V4_SWAP:** actions `0x070b0e` = SWAP_EXACT_IN, SETTLE, TAKE (the reference
  tx's exact shapes: `SETTLE(IMD, 0, payerIsUser=true)`, `TAKE(ETH, seller, 0)`).
- **Swap tuple:** the STANDARD v4-periphery `ExactInputParams`
  `{currencyIn, PathKey[] path, uint256[] maxHopSlippage, amountIn, amountOutMinimum}`,
  encoded with viem. viem reproduces the reference tx bytes exactly. The old
  "word 16 mystery / sqrtPriceLimit / trailing empty field" were misreadings
  of `maxHopSlippage` — we send `[]` and enforce slippage via
  `amountOutMinimum` (quoted from the V4 quoter on the hooked pool, minus
  the user's slippage).
- **No per-trade permit.** A standing allowance is enough. One-time chain,
  set automatically if missing, each leg mined before the next:
  `IMD.approve(Permit2, max)` → `Permit2.approve(IMD, hookRouter, max, max-uint48)`.
  Autonomy: the SCW's session key signs these itself (no prompt). Co-pilot:
  staged direct-sign steps (approve → approve → swap).
- **Pool:** hooked ETH/IMD, poolId `0x415829f7…a704`, fee 10000,
  tickSpacing 60, hooks `0xc6C965Bd…2840` (the pool the Uniswap UI trades).
- **Verified:** `imd-sell.test.mjs` pins the encoder to tx `0x6fbc3188…`;
  full-balance `eth_simulateV1` from SCW `0x3C73…4021` (7.29 IMD):
  Permit2 approve ✅ 47,818 gas → swap ✅ ~360k gas; minOut above quote
  reverts (slippage guard live). The UR with the same calldata reverts.

### Do NOT re-learn

1. The Universal Router reverts for this pool — the hook-router is the executor.
2. SETTLE_ALL/TAKE_ALL (0x0c/0x0f) with 2-field params reverted in simulation;
   use SETTLE/TAKE (0x0b/0x0e) as the reference tx does.
3. `findBestV3DollarPool` still reports ~$2B for the $33k USDC pool — irrelevant
   to IMD sells now (short-circuited), but it still skews dip-watcher's venue
   choice for IMD. **Not yet fixed.**
4. Constants must be EIP-55 checksummed or all-lowercase — an ALL-CAPS hex
   address (`0x23617E59…`) fails viem's checksum validation.

## Verification ladder (every new execution path)

1. **Structural**: `node --test imd-sell.test.mjs` — encoder pinned to the
   on-chain reference tx (re-fetch the raw tx with `scripts/fetch-ui-sell-tx.mjs`).
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
| `v4-hook-sell.mjs` | THE IMD sell: `executeImdEthSell`, `buildImdEthSwapCall`, `quoteImdToEth` |
| `imd-sell.test.mjs` | Encoder pinned to the on-chain reference tx |
| `scripts/fetch-ui-sell-tx.mjs` | Re-fetch the reference sell tx calldata |
| `sniper-extras.mjs` | `executeSniperSell` (IMD short-circuits to `executeImdEthSell`; other tokens use `resolveSellVenue`) |
| `direct-sell.mjs` | Capture-signer builders (watcher exit + sniper sell share one dispatcher) |
