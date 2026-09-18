#!/usr/bin/env node
// test-sell-execution.mjs — DRY-RUN simulation of the sell path.
// Mirrors scripts/test-v4-execution.mjs (the buy-side dry-run): resolves the
// venue exactly as executeSniperSell does (V4 → V3 dollar → V3 WETH), builds
// the REAL calldata via the same builder function the live path uses
// (buildV4SellCall), then eth_estimateGas's it WITHOUT sending. No funds
// move, no approvals change.
//
// Usage: node scripts/test-sell-execution.mjs <tokenAddress> [sellPct] [chainKey]
//   sellPct defaults to 1 (% of the wallet's token balance).

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { findBestV4Pool, findBestV3DollarPool, getErc20Balance } = await import("../dip-swap.mjs");
const { getChain, httpClient } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");
const { getNetwork, getTokenMeta, publicClient } = await import("../sniper-swap.mjs");
const { buildV4SellCall } = await import("../sniper-extras.mjs");
const { parseAbi, encodeFunctionData } = await import("viem");

const TOKEN = process.argv[2];
if (!TOKEN) { console.log("usage: node scripts/test-sell-execution.mjs <tokenAddress> [sellPct] [chainKey]"); process.exit(1); }
const SELL_PCT = Number(process.argv[3] ?? 1);
const CHAIN_KEY = process.argv[4] ?? "ethereum";
const dep = getChain(CHAIN_KEY);
const n = getNetwork(CHAIN_KEY);

const client = httpClient(CHAIN_KEY);
const signer = await resolveSigner(CHAIN_KEY);
console.log(`sell dry-run on ${dep.name} — token ${TOKEN}, ${SELL_PCT}% of balance`);

const meta = await getTokenMeta(CHAIN_KEY, TOKEN);
const balRaw = BigInt(await getErc20Balance(TOKEN, signer.address, CHAIN_KEY));
const amountIn = (balRaw * BigInt(Math.round(SELL_PCT))) / 100n;
if (amountIn <= 0n) { console.log("❌ balance is 0 — nothing to sell"); process.exit(1); }
const human = Number(amountIn) / 10 ** Number(meta.decimals ?? 18);
console.log(`selling ${human.toPrecision(8)} ${meta.symbol ?? ""} (${amountIn.toString()} raw)`);

// ── venue resolution (same priority as executeSniperSell) ───────────────────
const [v4, v3Dollar] = await Promise.all([
  findBestV4Pool(TOKEN, CHAIN_KEY).catch(() => null),
  findBestV3DollarPool(TOKEN, CHAIN_KEY).catch(() => null),
]);
let venue = null;
if (v4) venue = { dex: "V4", label: `Uniswap V4 ${(v4.fee / 10000).toFixed(2)}%`, poolAddress: v4.poolId, fee: v4.fee, tickSpacing: v4.tickSpacing, hooks: v4.hooks, currency0: v4.currency0, currency1: v4.currency1 };
else if (v3Dollar) venue = { dex: "V3_DOLLAR", label: `Uniswap V3 ${(v3Dollar.fee / 10000).toFixed(2)}% dollar-quoted`, poolAddress: v3Dollar.address, fee: v3Dollar.fee };
if (!venue) { console.log("❌ no sell venue found (V4 + V3 dollar both empty)"); process.exit(1); }
console.log(`venue: ${venue.label}`);

// ── calldata build + estimateGas (no send) ──────────────────────────────────
const V3_QUOTE_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const V3_SELL_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
let call;
if (venue.dex === "V4") {
  const { call: built, quotedOut, amountOutMinimum } = await buildV4SellCall({ chainKey: CHAIN_KEY, tokenAddress: TOKEN, amountIn, slippagePct: 3, pool: venue, recipient: signer.address });
  console.log("quote out (raw):", quotedOut.toString(), "· minOut:", amountOutMinimum.toString());
  call = { to: built.address, data: encodeFunctionData({ abi: built.abi, functionName: built.functionName, args: built.args }), value: built.value };
} else {
  const dollar = dep.dollar;
  const { result } = await publicClient(CHAIN_KEY).simulateContract({
    address: n.v3Quoter, abi: V3_QUOTE_ABI, functionName: "quoteExactInputSingle",
    args: [{ tokenIn: TOKEN, tokenOut: dollar, amountIn, fee: Number(venue.fee), sqrtPriceLimitX96: 0n }],
  });
  const quotedOut = result[0];
  console.log("quote out (raw):", quotedOut.toString());
  const data = encodeFunctionData({
    abi: V3_SELL_ABI, functionName: "exactInputSingle",
    args: [{ tokenIn: TOKEN, tokenOut: dollar, fee: Number(venue.fee), recipient: signer.address, amountIn, amountOutMinimum: quotedOut - (quotedOut * 300n) / 10000n, sqrtPriceLimitX96: 0n }],
  });
  call = { to: n.v3Router, data, value: 0n };
}

console.log("simulating ...");
try {
  const gas = await client.estimateGas({ account: signer.address, to: call.to, data: call.data, value: call.value });
  console.log(`✅ SIMULATION PASSED — gas estimate: ${gas.toString()}`);
} catch (e) {
  console.log("❌ SIMULATION FAILED:", String(e.message).slice(0, 400));
  const raw = JSON.stringify(e, Object.getOwnPropertyNames(e));
  const sel = raw.match(/0x[0-9a-f]{8}(?![0-9a-f])/g)?.filter((s) => s !== "0x00000000");
  if (sel) console.log("error selectors seen:", [...new Set(sel)].join(", "));
  process.exit(1);
}
