#!/usr/bin/env node
// diag-v3-recipient.mjs — hypothesis: the token restricts who can RECEIVE it.
// Quote works (recipient = QuoterV2). Swap reverts (recipient = wallet).
// Simulate the swap with different recipients, and probe raw token transfers.
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
const POOL = "0xA321D950082166d11DB11cFBd6e32A91e6144Ff0";
const dep = getChain("base");
const signer = await resolveSigner("base");
const VALUE = 1997350161767056n;
const QUOTER = dep.v3.quoterV2;

const rpcUrl = dep.httpRpc();
async function rpc(method, params_) {
  const res = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params_ }),
  });
  return res.json();
}

async function swapCall(recipient, tag) {
  const params = {
    tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient,
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
  const j = await rpc("eth_call", [{ from: signer.address, to: dep.v3.swapRouter02, data, value: "0x" + VALUE.toString(16) }, "latest"]);
  console.log(`${tag}:`, j.error ? "REVERT" : "OK " + (j.result || "").slice(0, 74));
}

await swapCall(signer.address, "recipient = wallet");
await swapCall(QUOTER, "recipient = QuoterV2");
await swapCall(POOL, "recipient = the V3 pool itself");

// raw transfer probe: pool -> wallet 1 wei of token (is the WALLET blocked?)
const transferTo = (to) => encodeFunctionData({
  abi: [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
  functionName: "transfer", args: [to, 1n],
});
const t1 = await rpc("eth_call", [{ from: POOL, to: TOKEN, data: transferTo(signer.address) }, "latest"]);
console.log("token.transfer(pool→wallet, 1wei):", t1.error ? "REVERT " + JSON.stringify(t1.error).slice(0, 200) : "OK");
const t2 = await rpc("eth_call", [{ from: POOL, to: TOKEN, data: transferTo(QUOTER) }, "latest"]);
console.log("token.transfer(pool→quoter, 1wei):", t2.error ? "REVERT " + JSON.stringify(t2.error).slice(0, 200) : "OK");
