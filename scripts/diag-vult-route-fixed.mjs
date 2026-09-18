// Dry-run: verify the fixed buyToken() venue resolution + the full
// ETH→USDC→VULT multi-hop quote, WITHOUT sending any transaction.
import { readFileSync } from "fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const swap = await import("../dip-swap.mjs");
const VULT = "0xb788144DF611029C60b859DF47e79B7726C4DEBa";

// replicate the patched buyToken() venue resolution
const v4 = await swap.findBestV4Pool(VULT, "ethereum").catch(() => null);
let venue = v4 ?? await swap.findBestPool(VULT, "ethereum");
console.log("initial venue:", venue.kind, venue.address ?? venue.poolId?.slice(0, 14), "fee", venue.fee, "liquidity", venue.liquidity?.toString?.() ?? "n/a");
if (venue?.liquidity === 0n) {
  const dollarPool = await swap.findBestV3DollarPool(VULT, "ethereum").catch(() => null);
  if (dollarPool) venue = dollarPool;
}
console.log("resolved venue:", venue.kind, venue.address, "fee", venue.fee);
console.log("isDollarQuotedV3:", swap.isDollarQuotedV3(venue, VULT, "ethereum"));

// live multi-hop quote for the watcher's $5 buy
const ethUsd = await swap.getEthUsdPrice("ethereum");
const wei = BigInt(Math.round((5 / ethUsd) * 1e18));
const { createPublicClient, http, parseAbi, encodePacked, formatUnits } = await import("viem");
const { ethereum } = await import("viem/chains");
const c = createPublicClient({ chain: ethereum, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) });
const path = encodePacked(["address","uint24","address","uint24","address"], ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 500, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 10000, VULT]);
const { result } = await c.simulateContract({
  address: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  abi: parseAbi(["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256, uint160, uint32, uint256)"]),
  functionName: "quoteExactInput", args: [path, wei],
});
console.log(`multi-hop quote for $5 (${Number(wei)/1e18} ETH): ${formatUnits(result[0], 18)} VULT — ✅ route works`);
