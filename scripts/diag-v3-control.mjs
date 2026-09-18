#!/usr/bin/env node
// diag-v3-control.mjs — control test: WETH→USDC through the SAME router
// multicall shape on Alchemy, full error, plus factory-pool sanity.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { ROUTER_ABI } = await import("../dip-swap.mjs");
const { getChain, httpClient } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");
const { encodeFunctionData } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const dep = getChain("base");
const signer = await resolveSigner("base");
const VALUE = 1997350161767056n;
const SWAPR = dep.v3.swapRouter02;

async function call(tag, tx) {
  const res = await fetch(dep.httpRpc(), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: signer.address, ...tx }, "latest"] }),
  });
  const j = await res.json();
  console.log(`${tag}:`, j.error ? JSON.stringify(j.error).slice(0, 400) : "OK");
}

// control 1: WETH→USDC via multicall{value}
const usdc = dep.dollar;
const p1 = {
  tokenIn: dep.weth, tokenOut: usdc, fee: 500, recipient: signer.address,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
};
await call("WETH→USDC multicall{value}", {
  to: SWAPR, value: "0x" + VALUE.toString(16),
  data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [[
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [VALUE] }),
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [p1] }),
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
  ]] }),
});

// control 2: USDC→WETH (no wrap, no msg.value — pure ERC20 path)
const p2 = {
  tokenIn: usdc, tokenOut: dep.weth, fee: 500, recipient: signer.address,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  amountIn: 1000000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
};
await call("USDC→WETH (no value)", {
  to: SWAPR, value: "0x0",
  data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [p2] }),
});

// sanity: does the factory agree the fee-10000 WETH/LAPTOP pool is 0xA321…?
const pool = await httpClient("base").readContract({
  address: dep.v3.factory, abi: ["function getPool(address,address,uint24) view returns (address)"],
  functionName: "getPool", args: [dep.weth, TOKEN, 10000],
});
console.log("factory getPool(WETH, LAPTOP, 10000):", pool);
