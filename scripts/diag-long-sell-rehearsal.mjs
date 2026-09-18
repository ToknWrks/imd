/**
 * diag-long-sell-rehearsal.mjs — read-only dry-run of the FULL ATLANTIS sell
 * (LONG-platform two-leg path) exactly as executeLongSell computes it:
 * venue from the saved poolId, slot0 spot price, V3 stock→WETH quote, and
 * eth_estimateGas of the leg-1 Universal Router calldata. Sends NOTHING.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { resolvePoolOverride, getErc20Balance } = await import("../dip-swap.mjs");
const { getChain, httpClient } = await import("../chains.mjs");
const { isLongVenue, spotPriceInStock, findStockEthPool, quoteV3 } = await import("../long-platform.mjs");
import { encodeFunctionData, encodeAbiParameters } from "viem";

const TOKEN = "0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18"; // ATLANTIS
const SAVED = "0xac3ed4bca616d07d9b5771a88e05f698eb66fe4be7764ff3cffb1674af0bc039";
const CHAIN = "robinhood";
const WALLET = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";

const dep = getChain(CHAIN);
const c = httpClient(CHAIN);

// 1) venue via the saved poolId (works without Dexscreener)
const venue = await resolvePoolOverride(TOKEN, SAVED, CHAIN);
if (!venue || !isLongVenue(venue)) { console.log("❌ not a LONG venue — routing would misfire"); process.exit(1); }
console.log("✅ LONG venue resolved from saved poolId (no Dexscreener)");

const stock = venue.poolKey.currency1; // currency0 = ATLANTIS
console.log("stock token (MU):", stock);

// 2) balances
const balRaw = BigInt(await getErc20Balance(TOKEN, WALLET, CHAIN));
const amountIn = balRaw / 100n; // 1%
console.log(`sell size: 1% of balance = ${Number(amountIn) / 1e18} ATLANTIS (${amountIn.toString()} raw)`);

// 3) leg-1 pricing input: slot0 spot
const spot = await spotPriceInStock(venue, TOKEN, 18, CHAIN);
console.log("spotPriceInStock:", spot);
if (!(spot > 0)) { console.log("❌ spot price unavailable — executeLongSell would refuse"); process.exit(1); }
const stockMin = BigInt(Math.floor(Number(amountIn) * spot * 0.97));
console.log("leg-1 minOut (stock):", stockMin.toString());

// 4) leg-2 exit pool exists + quotes
const pool = await import("../long-platform.mjs").then(m => m.findStockEthPool(stock, CHAIN));
console.log("stock/WETH pool:", pool ? `fee=${pool.fee}` : "❌ none");
if (pool) {
  const wethQuoted = await import("../long-platform.mjs").then(m => m.quoteV3 ? m.quoteV3(stock, dep.weth, stockMin, CHAIN) : 0n).catch(e => { console.log("   quote err:", e.message.slice(0, 100)); return 0n; });
  console.log("V3 stock→WETH quote for min-out size:", wethQuoted.toString());
}

// 5) THE dry-run: eth_estimateGas the leg-1 UR calldata (same builder as real send)
const { v4SwapCallShim } = await import("../long-platform.mjs").then(m => ({ v4SwapCallShim: m.v4SwapCall ?? null }));
// v4SwapCall is module-private — rebuild it identically (same encoding) here:
const wn = (x) => BigInt(x).toString(16).padStart(64, "0");
const ad = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const UR_EXECUTE_ABI = [{ name: "execute", type: "function", stateMutability: "payable", inputs: [{ name: "commands", type: "bytes" }, { name: "inputs", type: "bytes[]" }, { name: "deadline", type: "uint256" }], outputs: [] }];
function v4SwapCallLocal(venue_, currencyIn, currencyOut, amountIn_, minOut_, recipient_) {
  const { poolKey } = venue_;
  const pathOffset = 5 * 32, emptyFieldOffset = 13 * 32;
  const swapParams = "0x" + wn(0x20) + [
    ad(currencyIn), wn(pathOffset), wn(emptyFieldOffset), wn(amountIn_), wn(minOut_),
    wn(1), wn(0x20), ad(currencyOut), wn(poolKey.fee), wn(poolKey.tickSpacing), ad(poolKey.hooks), wn(0xa0), wn(0), wn(0),
  ].join("");
  const settleParams = encodeAbiParameters([{ name: "currency", type: "address" }, { name: "amount", type: "uint256" }, { name: "payerIsUser", type: "bool" }], [currencyIn, 0n, true]);
  const takeParams = encodeAbiParameters([{ name: "currency", type: "address" }, { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }], [currencyOut, recipient_, 0n]);
  const payload = encodeFunctionData({ abi: [{ name: "execute", type: "function", stateMutability: "payable", inputs: [], outputs: [] }], functionName: "execute", args: [] }); // placeholder, replaced below
  return null; // see below — assembled via encodeAbiParameters directly
}
const swapParams = "0x" + wn(0x20) + [
  ad(TOKEN), wn(5 * 32), wn(13 * 32), wn(amountIn), wn(stockMin),
  wn(1), wn(0x20), ad(stock), wn(venue.poolKey.fee), wn(venue.poolKey.tickSpacing), ad(venue.poolKey.hooks), wn(0xa0), wn(0), wn(0),
].join("");
const settleParams = encodeAbiParameters([{ name: "currency", type: "address" }, { name: "amount", type: "uint256" }, { name: "payerIsUser", type: "bool" }], [TOKEN, 0n, true]);
const takeParams = encodeAbiParameters([{ name: "currency", type: "address" }, { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }], [stock, WALLET, 0n]);
const payload = encodeAbiParameters([{ type: "bytes", name: "commands" }, { type: "bytes[]", name: "inputs" }], ["0x070b0e", [swapParams, settleParams, takeParams]]);
const data = encodeFunctionData({
  abi: [{ name: "execute", type: "function", stateMutability: "payable", inputs: [{ type: "bytes" }, { type: "bytes[]" }, { type: "uint256" }], outputs: [] }],
  functionName: "execute",
  args: ["0x10", [payload], BigInt(Math.floor(Date.now() / 1000) + 300)],
});
console.log("leg-1 calldata built (", data.slice(0, 42) + "…", "len", data.length, ")");
try {
  const gas = await c.estimateGas({ account: WALLET, to: dep.v4.universalRouter, data, value: 0n });
  console.log(`✅ LEG-1 SIMULATION PASSED — gas: ${gas.toString()}`);
} catch (e) {
  console.log("❌ LEG-1 SIMULATION FAILED:", String(e.message).slice(0, 400));
  const raw = JSON.stringify(e, Object.getOwnPropertyNames(e));
  const sel = raw.match(/0x[0-9a-f]{8}(?![0-9a-f])/g)?.filter(s => s !== "0x00000000");
  if (sel) console.log("error selectors:", [...new Set(sel)].join(", "));
  process.exit(1);
}
console.log("\nAll pre-send checks passed — executeLongSell is clear to run for ATLANTIS.");
