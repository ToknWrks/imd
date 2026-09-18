#!/usr/bin/env node
// diag-v3-math.mjs — reconcile quote vs. pool price vs. reserves.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { quoteBuy } = await import("../dip-swap.mjs");
const { getChain } = await import("../chains.mjs");
const { parseAbi, createPublicClient, http } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const POOL = "0xA321D950082166d11DB11cFBd6e32A91e6144Ff0";
const dep = getChain("base");
const client = createPublicClient({ transport: http(dep.httpRpc()) });
const VALUE = 1997350161767056n;

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);
const [s0, liq, t0, t1, fee] = await Promise.all([
  client.readContract({ address: POOL, abi: POOL_ABI, functionName: "slot0" }),
  client.readContract({ address: POOL, abi: POOL_ABI, functionName: "liquidity" }),
  client.readContract({ address: POOL, abi: POOL_ABI, functionName: "token0" }),
  client.readContract({ address: POOL, abi: POOL_ABI, functionName: "token1" }),
  client.readContract({ address: POOL, abi: POOL_ABI, functionName: "fee" }),
]);
console.log("pool tokens:", t0, "/", t1, "fee:", fee);
const s0arr = Array.isArray(s0) ? s0 : [s0.sqrtPriceX96, s0.tick, s0.observationIndex, s0.observationCardinality, s0.observationCardinalityNext, s0.feeProtocol, s0.unlocked];
console.log("slot0:", { sqrtPriceX96: s0arr[0].toString(), tick: s0arr[1].toString(), unlocked: s0arr[6] });
console.log("in-range liquidity:", liq.toString());

const s = Number(s0arr[0]) / 2 ** 96;
const humanRatio = s * s; // both tokens 18 decimals
console.log("implied spot (LAPTOP per WETH):", humanRatio);

const q = await quoteBuy(TOKEN, 10000, VALUE, "base");
console.log("quote for 0.002 ETH:", Number(q) / 1e18, "LAPTOP");
console.log("implied quote price (LAPTOP per WETH):", (Number(q) / 1e18) / (Number(VALUE) / 1e18));
