#!/usr/bin/env node
// diag-v3-struct.mjs — THE decisive test: SwapRouter02's ExactInputSingleParams
// has NO deadline field (deadline lives in multicall overload). Compare
// 8-field (current, misaligned) vs 7-field (correct) encodings.
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
const { encodeFunctionData, parseAbi } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const dep = getChain("base");
const signer = await resolveSigner("base");
const VALUE = 1997350161767056n;
const SWAPR = dep.v3.swapRouter02;

// CORRECT SwapRouter02 struct: no deadline
const ROUTER_ABI_V2 = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function wrapETH(uint256 value) payable",
  "function refundETH() payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

const rpcUrl = "https://base.drpc.org";
async function call(tag, data) {
  const res = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ from: signer.address, to: SWAPR, data, value: "0x" + VALUE.toString(16) }, "latest"] }),
  });
  const j = await res.json();
  console.log(`${tag}:`, j.error ? "REVERT " + JSON.stringify(j.error).slice(0, 160) : "OK ✅ out=" + (j.result || "").slice(2, 70));
  return !j.error;
}

// current (8-field, misaligned)
const p8 = {
  tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
};
const d8 = encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [[
  encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [VALUE] }),
  encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [p8] }),
  encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
]] });
await call("8-field struct (current code)", d8);

// correct 7-field struct
const p7 = {
  tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
  amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
};
const d7 = encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "multicall", args: [[
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "wrapETH", args: [VALUE] }),
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "exactInputSingle", args: [p7] }),
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "refundETH" }),
]] });
await call("7-field struct (correct) LAPTOP", d7);

// and the USDC control with 7-field
const usdc7 = { ...p7, tokenOut: dep.dollar, fee: 500 };
const d7u = encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "multicall", args: [[
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "wrapETH", args: [VALUE] }),
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "exactInputSingle", args: [usdc7] }),
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "refundETH" }),
]] });
await call("7-field struct (correct) USDC control", d7u);
