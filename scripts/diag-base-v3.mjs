#!/usr/bin/env node
// diag-base-v3.mjs — reproduce the LAPTOP Base buy failure offline.
// 1. What does findBestV4Pool/findBestPool return for the token on base?
// 2. eth_estimateGas the exact failing V3 exactInputSingle calldata → real revert reason.
// 3. Quote again live to see if the pool still exists / quote still works.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { findBestV4Pool, findBestPool, quoteBuy } = await import("../dip-swap.mjs");
const { getChain, httpClient } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const CHAIN = "base";
const ETH_WEI = 1997350161767056n; // the exact failed amount

const dep = getChain(CHAIN);
const client = httpClient(CHAIN);
const signer = await resolveSigner(CHAIN);

console.log("=== 1. venue discovery (what buyDip resolves when no override) ===");
const v4 = await findBestV4Pool(TOKEN, CHAIN).catch((e) => { console.log("findBestV4Pool error:", e.message); return null; });
console.log("V4 pool:", v4 ? JSON.stringify({ poolId: v4.poolId, fee: v4.fee, label: v4.label }) : "none");
if (!v4) {
  const v3 = await findBestPool(TOKEN, CHAIN).catch((e) => { console.log("findBestPool error:", e.message); return null; });
  console.log("V3 fallback:", v3 ? JSON.stringify(v3, (_, v) => typeof v === "bigint" ? v.toString() : v) : "none");
}

console.log("\n=== 2. live quote through V3 fee 10000 (did the pool/quote survive?) ===");
try {
  const out = await quoteBuy(TOKEN, 10000, ETH_WEI, CHAIN);
  console.log("quote OK, amountOut:", out.toString());
} catch (e) {
  console.log("quote FAILED:", e.message.slice(0, 300));
}

console.log("\n=== 3. eth_estimateGas the exact failing V3 calldata ===");
const params = {
  tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  amountIn: ETH_WEI, amountOutMinimum: 373266544989037702n, sqrtPriceLimitX96: 0n,
};
try {
  const gas = await client.estimateContractGas({
    address: dep.v3.swapRouter02,
    abi: [{ name: "exactInputSingle", type: "function", stateMutability: "payable", inputs: [{ components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" },
      { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" }, { name: "amountIn", type: "uint256" },
      { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" },
    ], type: "tuple" }], outputs: [{ type: "uint256" }] }],
    functionName: "exactInputSingle", args: [params], value: ETH_WEI, account: signer.address,
  });
  console.log("estimate OK — gas:", gas.toString());
} catch (e) {
  console.log("estimate FAILED (real revert reason):");
  console.log((e.message || String(e)).slice(0, 800));
}

console.log("\n=== 4. wallet balances on base ===");
const [ethBal, wethBal] = await Promise.all([
  client.getBalance({ address: signer.address }),
  client.readContract({ address: dep.weth, abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [signer.address] }),
]);
console.log(`ETH: ${Number(ethBal) / 1e18} · WETH: ${Number(wethBal) / 1e18}`);
