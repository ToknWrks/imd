#!/usr/bin/env node
// diag-v3-payer.mjs — from the trace: wrapETH succeeded (router now holds
// WETH), pool sent LAPTOP to the wallet, then pool's transferFrom FAILED.
// Decode WHO the transferFrom was from. If from=wallet, the callback expected
// the WALLET to pay — which happens when the pool thinks msg.sender (router)
// is also the swap's `recipient`... i.e. a struct-decode offset issue.
// Test: 7-field struct where recipient=ROUTER (settle in router space),
// plus a mainnet control with the same 7-field shape.
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
const { encodeFunctionData, parseAbi, pad, toHex } = await import("viem");

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

const swap7 = (recipient) => ({
  tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient,
  amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
});
const mc = (p) => encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "multicall", args: [[
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "wrapETH", args: [VALUE] }),
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "exactInputSingle", args: [p] }),
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "refundETH" }),
]] });

async function call(rpcUrl, tag, data, valueHex) {
  const res = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ from: signer.address, to: SWAPR, data, value: valueHex }, "latest"] }),
  });
  const j = await res.json();
  let reason = "";
  const d = j.error?.data;
  if (typeof d === "string" && d.startsWith("0x08c379a0")) {
    const { decodeAbiParameters, parseAbiParameters } = await import("viem");
    try { reason = " → " + decodeAbiParameters(parseAbiParameters("string"), "0x" + d.slice(10))[0]; } catch {}
  }
  console.log(`${tag}:`, j.error ? "REVERT " + JSON.stringify(j.error.message).slice(0, 100) + reason : "OK ✅ out=" + (j.result || "").slice(2, 70));
}

const RPC = "https://base.drpc.org";
await call(RPC, "7-field recipient=WALLET", mc(swap7(signer.address)), "0x" + VALUE.toString(16));
await call(RPC, "7-field recipient=ROUTER", mc(swap7(SWAPR)), "0x" + VALUE.toString(16));

// mainnet control with the SAME 7-field shape — if mainnet reverts STF too,
// the shape itself is wrong; if OK, Base-specific.
const M = {
  router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  rpc: "https://eth-mainnet.g.alchemy.com/v2/" + (process.env.ALCHEMY_API_KEY || "").trim(),
};
const pm = {
  tokenIn: M.weth, tokenOut: M.usdc, fee: 500, recipient: signer.address,
  amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
};
const dm = encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "multicall", args: [[
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "wrapETH", args: [VALUE] }),
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "exactInputSingle", args: [pm] }),
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "refundETH" }),
]] });
await call(M.rpc, "mainnet 7-field recipient=WALLET", dm, "0x" + VALUE.toString(16));
