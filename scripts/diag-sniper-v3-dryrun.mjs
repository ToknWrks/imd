#!/usr/bin/env node
// diag-sniper-v3-dryrun.mjs — DRY-RUN of the sniper page's FIXED V3 buy path
// on Base: the exact multicall(exactInputSingle, refundETH) calldata
// executeSniperBuy() now sends, eth_estimateGas'd. No funds move.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { NETWORKS, quoteV3Pub } = await import("../sniper-swap.mjs").catch(async () => {
  // quoteV3 isn't exported; fall back to inline quoter call
  return {};
});
const { createPublicClient, http, parseAbi, encodeFunctionData } = await import("viem");
const { resolveSigner } = await import("../signer.mjs");

const n = NETWORKS.base;
const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29"; // LAPTOP
const ETH_WEI = 10000000000000n; // 0.01 ETH

const c = createPublicClient({ transport: http(process.env.ALCHEMY_API_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : "https://mainnet.base.org") });
const signer = await resolveSigner("base");

// quote via the same quoter sniper-swap uses
const QUOTER = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160,uint32,uint256)"]);
const { result } = await c.simulateContract({
  address: n.v3Quoter, abi: QUOTER, functionName: "quoteExactInputSingle",
  args: [{ tokenIn: n.weth, tokenOut: TOKEN, amountIn: ETH_WEI, fee: 10000, sqrtPriceLimitX96: 0n }],
});
const quotedOut = result[0];
const amountOutMinimum = quotedOut - (quotedOut * 300n) / 10000n;
console.log(`quote: ${Number(quotedOut) / 1e18} LAPTOP, min out: ${Number(amountOutMinimum) / 1e18}`);

// the exact calldata executeSniperBuy() now sends
const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function refundETH() payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);
const calldatas = [
  encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [{
    tokenIn: n.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
    amountIn: ETH_WEI, amountOutMinimum, sqrtPriceLimitX96: 0n,
  }] }),
  encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
];

try {
  const gas = await c.estimateContractGas({
    address: n.v3Router, abi: ROUTER_ABI, functionName: "multicall",
    args: [calldatas], value: ETH_WEI, account: signer.address,
  });
  console.log(`✅ sniper V3 dry-run OK — gas ${gas} (multicall swap+refund, no wrap)`);
} catch (e) {
  console.log("❌ dry-run FAILED:", (e.message || String(e)).slice(0, 400));
  process.exit(1);
}
