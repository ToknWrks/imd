#!/usr/bin/env node
// diag-v3-reason.mjs — print the FULL RPC error (message included) for each
// failing shape. Base nodes often embed the revert reason in the message.
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
const { encodeFunctionData } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const dep = getChain("base");
const signer = await resolveSigner("base");
const VALUE = 1997350161767056n;

const swapParams = (min = 0n) => ({
  tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  amountIn: VALUE, amountOutMinimum: min, sqrtPriceLimitX96: 0n,
});

const rpcUrl = "https://mainnet.base.org";
async function call(tag, tx) {
  const res = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: signer.address, ...tx }, "latest"] }),
  });
  const j = await res.json();
  console.log(`${tag}:`, j.error ? JSON.stringify(j.error).slice(0, 600) : "OK");
}

// 1. quote again — confirm it still succeeds
try {
  const q = await quoteBuy(TOKEN, 10000, VALUE, "base");
  console.log("quote:", q.toString());
} catch (e) {
  console.log("quote FAILED now:", e.message.slice(0, 300));
}

// 2. router multicall — full error
await call("router multicall", {
  to: dep.v3.swapRouter02, value: "0x" + VALUE.toString(16),
  data: encodeFunctionData({
    abi: ROUTER_ABI, functionName: "multicall",
    args: [[
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [VALUE] }),
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [swapParams()] }),
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
    ]],
  }),
});

// 3. plain exactInputSingle — full error
await call("plain exactInputSingle", {
  to: dep.v3.swapRouter02, value: "0x" + VALUE.toString(16),
  data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [swapParams()] }),
});

// 4. sanity: a DIFFERENT token through the same router shape (known-good WETH/USDC pool fee 500)
const USDC = dep.dollar;
const usdcParams = {
  tokenIn: dep.weth, tokenOut: USDC, fee: 500, recipient: signer.address,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
};
await call("control: WETH→USDC multicall", {
  to: dep.v3.swapRouter02, value: "0x" + VALUE.toString(16),
  data: encodeFunctionData({
    abi: ROUTER_ABI, functionName: "multicall",
    args: [[
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [VALUE] }),
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [usdcParams] }),
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
    ]],
  }),
});
