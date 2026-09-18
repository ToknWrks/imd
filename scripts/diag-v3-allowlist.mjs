#!/usr/bin/env node
// diag-v3-allowlist.mjs — does LAPTOP discriminate between contracts?
// transfer pool→QuoterV2 worked; test pool→SwapRouter02. Also test tiny
// swap sizes through the real router path.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { ROUTER_ABI, quoteBuy } = await import("../dip-swap.mjs");
const { getChain } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");
const { encodeFunctionData, decodeAbiParameters, parseAbiParameters } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const POOL = "0xA321D950082166d11DB11cFBd6e32A91e6144Ff0";
const dep = getChain("base");
const signer = await resolveSigner("base");
const SWAPR = dep.v3.swapRouter02;
const QUOTER = dep.v3.quoterV2;

const rpcUrl = "https://base.drpc.org";
async function rpc(method, params_) {
  const res = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params_ }),
  });
  return res.json();
}
const transfer = (to, amt) => encodeFunctionData({
  abi: [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
  functionName: "transfer", args: [to, amt],
});

for (const [tag, to] of [["pool→QuoterV2", QUOTER], ["pool→SwapRouter02", SWAPR], ["pool→signer", signer.address]]) {
  const j = await rpc("eth_call", [{ from: POOL, to: TOKEN, data: transfer(to, 1n) }, "latest"]);
  console.log(`token.transfer ${tag}:`, j.error ? "REVERT " + JSON.stringify(j.error).slice(0, 200) : "OK");
}

// tiny swap through the real router multicall path
for (const wei of [1997350161767056n, 100000000000n, 1000000n]) {
  const q = await quoteBuy(TOKEN, 10000, wei, "base").catch(() => null);
  const p = {
    tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    amountIn: wei, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
  };
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [[
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [wei] }),
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [p] }),
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
  ]] });
  const j = await rpc("eth_call", [{ from: signer.address, to: SWAPR, data, value: "0x" + wei.toString(16) }, "latest"]);
  console.log(`swap ${Number(wei) / 1e18} ETH (quote ${q ? Number(q) / 1e18 : "n/a"}):`, j.error ? "REVERT " + JSON.stringify(j.error).slice(0, 200) : "OK ✅");
}
