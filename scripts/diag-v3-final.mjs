#!/usr/bin/env node
// diag-v3-final.mjs — get revert DATA for the real failing router call,
// plus a CORRECT direct-pool swap (zeroForOne=true for WETH(token0)→token,
// price limit near MAX as the router does implicitly).
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { ROUTER_ABI } = await import("../dip-swap.mjs");
const { getChain } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");
const { encodeFunctionData, decodeAbiParameters, parseAbiParameters, encodeAbiParameters } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const POOL = "0xA321D950082166d11DB11cFBd6e32A91e6144Ff0";
const dep = getChain("base");
const signer = await resolveSigner("base");
const VALUE = 1997350161767056n;
const MAX_SQRT = 4295128741n; // MIN_SQRT_RATIO + 1 — the "no limit" value for zeroForOne (limit must be BELOW current price)

const rpcUrl = dep.httpRpc();
async function rpc(method, params_) {
  const res = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params_ }),
  });
  return res.json();
}
function decodeRevert(data) {
  if (!data || data === "0x") return "(no data)";
  const sel = data.slice(0, 10);
  if (sel === "0x08c379a0") {
    try { return "Error(string): " + decodeAbiParameters(parseAbiParameters("string"), "0x" + data.slice(10))[0]; }
    catch { return "Error(string) undecodable: " + data.slice(0, 200); }
  }
  return "selector " + sel + " raw " + data.slice(0, 300);
}
async function callTo(from, to, data, value = "0x0", tag = "") {
  const j = await rpc("eth_call", [{ from, to, data, value }, "latest"]);
  if (j.error) {
    const d = j.error.data ?? (typeof j.error === "string" ? j.error : null);
    console.log(`${tag}: REVERT — ${decodeRevert(typeof d === "string" ? d : null)}${d ? "" : " (rpc stripped data)"}`);
    return false;
  }
  console.log(`${tag}: OK ${j.result.slice(0, 74)}`);
  return true;
}

// 1. the REAL failing call: router multicall, wallet-funded
const swapParams = {
  tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
};
const multicallData = encodeFunctionData({
  abi: ROUTER_ABI, functionName: "multicall",
  args: [[
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [VALUE] }),
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [swapParams] }),
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
  ]],
});
await callTo(signer.address, dep.v3.swapRouter02, multicallData, "0x" + VALUE.toString(16), "router multicall (real path)");

// 2. CORRECT direct pool swap: WETH is token0 (verified earlier), so
//    zeroForOne=true, amount0 specified (exactIn), sqrtPriceLimit near MAX
const SWAP_ABI = [{
  name: "swap", type: "function", stateMutability: "nonpayable",
  inputs: [{ type: "address" }, { type: "bool" }, { type: "int256" }, { type: "uint160" }, { type: "bytes" }],
  outputs: [{ type: "int256" }, { type: "uint256" }],
}];
const cbData = encodeAbiParameters(parseAbiParameters("address, uint24"), [signer.address, 10000n]);
await callTo(signer.address, POOL,
  encodeFunctionData({ abi: SWAP_ABI, functionName: "swap", args: [signer.address, true, BigInt(VALUE), MAX_SQRT, cbData] }),
  "0x0", "direct pool swap (correct params)");
