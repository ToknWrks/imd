#!/usr/bin/env node
// diag-v3-struct-trace.mjs — trace the 7-field struct multicall on Base:
// which subcall fails now (wrapETH ran? where does STF fire?).
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { getChain } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");
const { encodeFunctionData, parseAbi, decodeAbiParameters, parseAbiParameters } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const dep = getChain("base");
const signer = await resolveSigner("base");
const VALUE = 1997350161767056n;
const SWAPR = dep.v3.swapRouter02;

const ROUTER_ABI_V2 = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function wrapETH(uint256 value) payable",
  "function refundETH() payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

const p7 = {
  tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
  amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
};
const data = encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "multicall", args: [[
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "wrapETH", args: [VALUE] }),
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "exactInputSingle", args: [p7] }),
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "refundETH" }),
]] });

const res = await fetch("https://base.drpc.org", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debug_traceCall",
    params: [{ from: signer.address, to: SWAPR, data, value: "0x" + VALUE.toString(16) }, "latest", { tracer: "callTracer" }] }),
});
const j = await res.json();
if (j.error) { console.log("trace err:", j.error.message); process.exit(1); }

const lines = [];
let deepest = null, deepestDepth = -1;
const walk = (n, depth) => {
  const fail = !!(n.error || n.revertReason);
  lines.push(`${"  ".repeat(depth)}${fail ? "❌" : "·"} ${n.type} to=${n.to} sel=${(n.input || "0x").slice(0, 10)} val=${n.value ?? "0"}`);
  if (fail && depth > deepestDepth) { deepest = n; deepestDepth = depth; }
  for (const c of n.calls || []) walk(c, depth + 1);
};
walk(j.result, 0);
console.log(lines.join("\n"));
if (deepest) {
  console.log(`\nDEEPEST FAILURE (depth ${deepestDepth}):`, deepest.type, deepest.to, "sel=" + (deepest.input || "").slice(0, 10));
  const out = deepest.output || deepest.revertReason || "";
  if (String(out).startsWith("0x08c379a0")) {
    try { console.log("decoded reason:", decodeAbiParameters(parseAbiParameters("string"), "0x" + String(out).slice(10))[0]); } catch {}
  }
  console.log("raw:", String(out).slice(0, 200));
}
