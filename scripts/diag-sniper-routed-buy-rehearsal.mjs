/**
 * diag-sniper-routed-buy-rehearsal.mjs — read-only rehearsal of the routed
 * sniper buy for a token/dollar-pool token (IF on Robinhood): verifies the
 * exact path buyDipMultiHop builds (ETH→USDG→IF), quotes it, and
 * eth_estimateGas's the built calldata. Sends NOTHING.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

for (const line of readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { findBestV3DollarPool, findBestPool, getEthUsdPrice, quoteBuy } = await import("../dip-swap.mjs");
const { getChain, httpClient } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");
const { parseAbi, encodePacked, encodeFunctionData } = await import("viem");

const CHAIN = "robinhood";
const IF = "0x232cdfc415d10b673845d83dc02ba2eabe7e30d1";
const dep = getChain(CHAIN);
const signer = await resolveSigner(CHAIN);
console.log("signer:", signer.address);

const ethUsd = await (await import("../dip-swap.mjs")).getEthUsdPrice(CHAIN);
const ethAmountWei = 5_000_000_000_000_000n; // 0.005 ETH
const usdSize = (Number(ethAmountWei) / 1e18) * ethUsd;
console.log(`buy rehearsal: 0.005 ETH ≈ $${usdSize.toFixed(2)}`);

// 1) token leg pool (the V3 dollar-quoted pool buyDipMultiHop needs)
const v3d = await findBestV3DollarPool(IF, CHAIN);
if (!v3d) { console.log("❌ no V3 dollar pool for IF — multi-hop impossible"); process.exit(1); }
console.log(`token leg: V3 fee=${v3d.fee} liqUsd=${Math.round(v3d.liquidityUsd)}`);

// 2) dollar leg: WETH/USDG V3 pool at fee 500
const c = httpClient(CHAIN);
const wethDollarPool = await c.readContract({
  address: dep.v3.factory, abi: parseAbi(["function getPool(address,address,uint24) view returns (address)"]),
  functionName: "getPool", args: [dep.weth, dep.dollar, 500],
});
if (!wethDollarPool || wethDollarPool === "0x0000000000000000000000000000000000000000") {
  console.log("❌ no WETH/USDG V3 pool at fee 500 — multi-hop impossible");
  process.exit(1);
}
console.log("WETH/USDG V3 pool (fee 500):", wethDollarPool);

// 3) quote the full path ETH→USDG→IF
const path = encodePacked(
  ["address", "uint24", "address", "uint24", "address"],
  [dep.weth, 500, dep.dollar, v3d.fee, IF],
);
const QUOTER_PATH_ABI = parseAbi(["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint256[] amounts)"]);
const { result } = await c.simulateContract({
  address: dep.v3.quoterV2, abi: QUOTER_PATH_ABI, functionName: "quoteExactInput",
  args: [path, ethAmountWei],
});
const quotedOut = result[0];
const bps = 300n;
const amountOutMinimum = quotedOut - (quotedOut * bps) / 10000n;
console.log("multi-hop quote:", (Number(quotedOut) / 1e18).toFixed(2), "IF · minOut:", (Number(amountOutMinimum) / 1e18).toFixed(2));

// 4) eth_estimateGas the exact calldata buyDipMultiHop sends (no send)
const params = { path, recipient: signer.address, amountIn: ethAmountWei, amountOutMinimum };
const data = encodeFunctionData({
  abi: parseAbi([
    "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
    "function refundETH() payable",
    "function multicall(bytes[] data) payable returns (bytes[] results)",
  ]),
  functionName: "multicall",
  args: [[
    encodeFunctionData({ abi: parseAbi(["function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)"]), functionName: "exactInput", args: [params] }),
    encodeFunctionData({ abi: parseAbi(["function refundETH() payable"]), functionName: "refundETH" }),
  ]],
});
const gas = await c.estimateGas({ account: signer.address, to: dep.v3.swapRouter02, data, value: ethAmountWei });
console.log(`✅ ROUTED BUY REHEARSAL PASS — gas: ${gas.toString()}`);
