// Compare the pool-derived VULT price (what the dashboard uses) vs the
// price implied by an actual QuoterV2 multi-hop quote (what we really pay).
import { readFileSync } from "fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const swap = await import("../dip-swap.mjs");
const { createPublicClient, http, parseAbi, encodePacked, formatUnits } = await import("viem");
const { ethereum } = await import("viem/chains");
const VULT = "0xb788144DF611029C60b859DF47e79B7726C4DEBa";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const c = createPublicClient({ chain: ethereum, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) });

// what the watcher/dashboard price feed says
const pool = await swap.findBestV3DollarPool(VULT, "ethereum");
console.log("dollar pool:", pool.address, "fee", pool.fee, "token0", pool.token0);

// quote $50 worth to see the real effective price at size
const ethUsd = await swap.getEthUsdPrice("ethereum");
const wei = BigInt(Math.round((50 / ethUsd) * 1e18));
const path = encodePacked(["address","uint24","address","uint24","address"], [WETH, 500, USDC, 10000, VULT]);
const { result } = await c.simulateContract({
  address: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  abi: parseAbi(["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256, uint160, uint32, uint256)"]),
  functionName: "quoteExactInput", args: [path, wei],
});
const out = Number(formatUnits(result[0], 18));
console.log(`$50 buys ${out.toFixed(2)} VULT → effective price $${(50/out).toFixed(6)}/VULT`);
