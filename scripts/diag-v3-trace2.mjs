#!/usr/bin/env node
// diag-v3-trace2.mjs — try multiple public Base RPCs for debug_traceCall
// (callTracer) on the failing router multicall; print the innermost revert.
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

const ENDPOINTS = [
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://base.drpc.org",
  "https://base-pokt.nodies.app",
  "https://1rpc.io/base",
  "https://base.meowrpc.com",
  "https://rpc.ankr.com/base",
];

for (const url of ENDPOINTS) {
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debug_traceCall",
        params: [{ from: signer.address, to: dep.v3.swapRouter02, data, value: "0x" + VALUE.toString(16) }, "latest", { tracer: "callTracer" }] }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json();
    if (j.error) { console.log(`[${url.slice(8, 32)}] err: ${j.error.message.slice(0, 80)}`); continue; }
    // walk to innermost failing frame
    let deepest = null;
    const walk = (n) => {
      if (n.error || n.revertReason) deepest = n;
      for (const c of n.calls || []) walk(c);
    };
    walk(j.result);
    console.log(`\n[${url.slice(8, 32)}] TRACE — top.error=${j.result.error ?? "none"}`);
    if (deepest) {
      console.log("  deepest failing call:", deepest.type, deepest.to);
      console.log("  error:", deepest.error);
      console.log("  revertReason:", deepest.revertReason);
      console.log("  input sel:", (deepest.input || "").slice(0, 10));
      console.log("  output:", (deepest.output || "").slice(0, 300));
      if (deepest.output?.startsWith?.("0x08c379a0")) {
        const { decodeAbiParameters, parseAbiParameters } = await import("viem");
        try { console.log("  decoded:", decodeAbiParameters(parseAbiParameters("string"), "0x" + deepest.output.slice(10))[0]); } catch {}
      }
    } else {
      console.log("  no failing frame?? gasUsed:", j.result.gasUsed);
    }
    break; // first endpoint that traces wins
  } catch (e) {
    console.log(`[${url.slice(8, 32)}] fail: ${e.message.slice(0, 80)}`);
  }
}
