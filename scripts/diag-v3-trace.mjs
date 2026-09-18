#!/usr/bin/env node
// diag-v3-trace.mjs — debug_traceCall with callTracer to find the innermost revert.
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
const { encodeFunctionData } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const dep = getChain("base");
const signer = await resolveSigner("base");
const VALUE = 1997350161767056n;

const params = {
  tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
};
const data = encodeFunctionData({
  abi: ROUTER_ABI, functionName: "multicall",
  args: [[
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [VALUE] }),
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params] }),
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
  ]],
});

const rpcUrl = dep.httpRpc();
async function rpc(method, params_) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params_ }),
  });
  return res.json();
}

// 1. try debug_traceCall
let j = await rpc("debug_traceCall", [{ from: signer.address, to: dep.v3.swapRouter02, data, value: "0x" + VALUE.toString(16) }, "latest", { tracer: "callTracer" }]);
if (j.error) {
  console.log("debug_traceCall unsupported/failed:", JSON.stringify(j.error).slice(0, 300));
} else if (j.result) {
  // walk the trace for the deepest failed call
  const lines = [];
  const walk = (n, depth) => {
    lines.push(`${"  ".repeat(depth)}${n.type} ${n.type === "CALL" || n.type === "STATICCALL" || n.type === "DELEGATECALL" ? n.to : ""} ${n.error ? "❌ " + n.error + " out=" + (n.output || "").slice(0, 200) : ""}`);
    for (const c of n.calls || []) walk(c, depth + 1);
  };
  walk(j.result, 0);
  console.log(lines.join("\n"));
}

// 2. bisect: wrapETH alone
const wrapOnly = encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [VALUE] });
const j2 = await rpc("eth_call", [{ from: signer.address, to: dep.v3.swapRouter02, data: wrapOnly, value: "0x" + VALUE.toString(16) }, "latest"]);
console.log("\nwrapETH alone:", j2.error ? "REVERT " + JSON.stringify(j2.error).slice(0, 200) : "OK");

// 3. bisect: wrapETH + refundETH (no swap)
const wrapRefund = encodeFunctionData({
  abi: ROUTER_ABI, functionName: "multicall",
  args: [[
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [VALUE] }),
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
  ]],
});
const j3 = await rpc("eth_call", [{ from: signer.address, to: dep.v3.swapRouter02, data: wrapRefund, value: "0x" + VALUE.toString(16) }, "latest"]);
console.log("wrap+refund:", j3.error ? "REVERT " + JSON.stringify(j3.error).slice(0, 200) : "OK");
