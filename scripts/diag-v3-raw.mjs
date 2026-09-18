#!/usr/bin/env node
// diag-v3-raw.mjs — raw fetch eth_call to capture the full revert payload.
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
const res = await fetch(rpcUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: signer.address, to: dep.v3.swapRouter02, data, value: "0x" + VALUE.toString(16) }, "latest"] }),
});
const j = await res.json();
console.log(JSON.stringify(j, null, 2).slice(0, 2000));

if (j.error?.data?.startsWith?.("0x")) {
  const sel = j.error.data.slice(0, 10);
  console.log("\nrevert selector:", sel);
  if (sel === "0x08c379a0") {
    // Error(string)
    const { decodeAbiParameters, parseAbiParameters } = await import("viem");
    const [msg] = decodeAbiParameters(parseAbiParameters("string"), "0x" + j.error.data.slice(10));
    console.log("revert message:", msg);
  }
}
