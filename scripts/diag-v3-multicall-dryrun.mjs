#!/usr/bin/env node
// diag-v3-multicall-dryrun.mjs — DRY-RUN of the FIXED V3 buy path on Base.
// Builds the exact multicall(exactInputSingle, refundETH) calldata buyDip()
// now sends (7-field struct, NO wrapETH) and eth_estimateGas's it. No funds move.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { ROUTER_ABI, quoteBuy } = await import("../dip-swap.mjs");
const { getChain, httpClient } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");
const { encodeFunctionData } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29"; // LAPTOP
const CHAIN = "base";
const ETH_WEI = 10000000000000n; // 0.01 ETH — same as the user's working swap

const dep = getChain(CHAIN);
const client = httpClient(CHAIN);
const signer = await resolveSigner(CHAIN);

const quotedOut = await quoteBuy(TOKEN, 10000, ETH_WEI, CHAIN);
const amountOutMinimum = quotedOut - (quotedOut * 300n) / 10000n; // 3% slippage
console.log(`quote: ${Number(quotedOut) / 1e18} LAPTOP, min out: ${Number(amountOutMinimum) / 1e18}`);

const params = {
  tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
  amountIn: ETH_WEI, amountOutMinimum, sqrtPriceLimitX96: 0n,
};
const calldatas = [
  encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params] }),
  encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
];
try {
  const gas = await client.estimateContractGas({
    address: dep.v3.swapRouter02, abi: ROUTER_ABI, functionName: "multicall",
    args: [calldatas], value: ETH_WEI, account: signer.address,
  });
  console.log(`✅ dry-run OK — gas ${gas} (7-field struct, no wrap, router pays from msg.value)`);
} catch (e) {
  console.log("❌ dry-run FAILED:", (e.message || String(e)).slice(0, 400));
  process.exit(1);
}
