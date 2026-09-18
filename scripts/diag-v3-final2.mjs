#!/usr/bin/env node
// diag-v3-final2.mjs — THE fix candidate: multicall([exactInputSingle(7f),
// refundETH()]) with msg.value, NO wrapETH (router wraps from its own balance
// in the swap callback). Test LAPTOP + USDC control on Base.
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

const ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function refundETH() payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

const mc = (p) => encodeFunctionData({ abi: ABI, functionName: "multicall", args: [[
  encodeFunctionData({ abi: ABI, functionName: "exactInputSingle", args: [p] }),
  encodeFunctionData({ abi: ABI, functionName: "refundETH" }),
]] });

async function call(rpcUrl, tag, data) {
  const res = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ from: signer.address, to: SWAPR, data, value: "0x" + VALUE.toString(16) }, "latest"] }),
  });
  const j = await res.json();
  let reason = "";
  const d = j.error?.data;
  if (typeof d === "string" && d.startsWith("0x08c379a0")) {
    const { decodeAbiParameters, parseAbiParameters } = await import("viem");
    try { reason = " → " + decodeAbiParameters(parseAbiParameters("string"), "0x" + d.slice(10))[0]; } catch {}
  }
  console.log(`${tag}:`, j.error ? "REVERT " + (j.error.message?.slice(0, 80) ?? "") + reason : "OK ✅ out=" + (j.result || "").slice(0, 200));
}

const RPC = "https://base.drpc.org";
const pLaptop = {
  tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
  amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
};
await call(RPC, "base LAPTOP  multicall(swap7+refund){value} no-wrap", mc(pLaptop));

const pUsdc = { ...pLaptop, tokenOut: dep.dollar, fee: 500 };
await call(RPC, "base USDC    multicall(swap7+refund){value} no-wrap", mc(pUsdc));
