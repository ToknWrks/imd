#!/usr/bin/env node
// diag-v3-fulltrace.mjs — FULL callTracer trace of the failing swap; find the
// MAXIMUM-DEPTH failing frame and decode its revert data.
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
const { encodeFunctionData, decodeAbiParameters, parseAbiParameters } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const dep = getChain("base");
const signer = await resolveSigner("base");
const VALUE = 1997350161767056n;

const swapParams = {
  tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
};
const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [[
  encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [VALUE] }),
  encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [swapParams] }),
  encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
]] });

async function trace(tx, tag) {
  const res = await fetch("https://base.drpc.org", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debug_traceCall",
      params: [{ from: signer.address, ...tx }, "latest", { tracer: "callTracer" }] }),
  });
  const j = await res.json();
  if (j.error) { console.log(tag, "trace err:", j.error.message); return; }
  const lines = [];
  let deepest = null, deepestDepth = -1;
  const walk = (n, depth, path) => {
    const fail = !!(n.error || n.revertReason);
    lines.push(`${"  ".repeat(depth)}${fail ? "❌" : "·"} ${n.type} to=${n.to} sel=${(n.input || "0x").slice(0, 10)} val=${n.value ?? "0"}`);
    if (fail && depth > deepestDepth) { deepest = n; deepestDepth = depth; }
    for (const c of n.calls || []) walk(c, depth + 1);
  };
  walk(j.result, 0, "");
  console.log(`\n=== ${tag} ===`);
  console.log(lines.join("\n"));
  if (deepest) {
    console.log(`\nDEEPEST FAILURE (depth ${deepestDepth}):`, deepest.type, deepest.to);
    console.log("  error:", deepest.error, "| revertReason:", deepest.revertReason);
    console.log("  input:", (deepest.input || "").slice(0, 10));
    const out = deepest.output || deepest.revertReason || "";
    if (String(out).startsWith("0x08c379a0")) {
      try { console.log("  decoded reason:", decodeAbiParameters(parseAbiParameters("string"), "0x" + String(out).slice(10))[0]); } catch { console.log("  raw:", String(out).slice(0, 300)); }
    } else console.log("  output:", String(out).slice(0, 300));
  }
}

await trace({ to: dep.v3.swapRouter02, data, value: "0x" + VALUE.toString(16) }, "router multicall LAPTOP");
