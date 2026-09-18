#!/usr/bin/env node
// diag-v3-inner.mjs — simulate the inner exactInputSingle as the ROUTER
// (post-wrapETH state: router holds the WETH) to see if the swap leg works
// when funded, vs when the wallet must deliver WETH directly.
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

const params = (min) => ({
  tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  amountIn: VALUE, amountOutMinimum: min, sqrtPriceLimitX96: 0n,
});

const rpcUrl = dep.httpRpc();
async function rpc(method, params_) {
  const res = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params_ }),
  });
  return res.json();
}

const toRouter = dep.v3.swapRouter02;

// A. inner exactInputSingle as if router itself called it (router-funded)
const inner = encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params(0n)] });
const a = await rpc("eth_call", [{ from: dep.v3.swapRouter02, to: dep.v3.swapRouter02, data: inner, value: "0x0" }, "latest"]);
console.log("inner swap (router-funded, min=0):", a.error ? "REVERT " + JSON.stringify(a.error).slice(0, 250) : "OK " + (a.result || "").slice(0, 80));

// B. wallet-funded direct exactInputSingle (the ORIGINAL failing shape) for comparison
const direct = encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params(0n)] });
const b = await rpc("eth_call", [{ from: signer.address, to: dep.v3.swapRouter02, data: direct, value: "0x" + VALUE.toString(16) }, "latest"]);
console.log("direct swap (wallet-funded, min=0):", b.error ? "REVERT " + JSON.stringify(b.error).slice(0, 250) : "OK " + (b.result || "").slice(0, 80));

// C. probe the token itself: does it have a 100% transfer tax / block transfers?
const ERC20 = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];
const c1 = await rpc("eth_call", [{ to: TOKEN, data: encodeFunctionData({ abi: [{ name: "decimals", type: "function", stateMutability: "pure", inputs: [], outputs: [{ type: "uint8" }] }], functionName: "decimals" }) }, "latest"]);
const c2 = await rpc("eth_call", [{ to: TOKEN, data: encodeFunctionData({ abi: [{ name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }], functionName: "symbol" }) }, "latest"]);
console.log("token decimals raw:", c1.result, "· symbol raw:", c2.result, "· decimals err:", JSON.stringify(c1.error || null).slice(0, 150));
