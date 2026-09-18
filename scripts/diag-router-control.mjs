#!/usr/bin/env node
// diag-router-control.mjs — identical multicall(wrap+swap+refund) shape on
// ETHEREUM mainnet (canonical SwapRouter02) vs Base. If mainnet OK and Base
// reverts, the problem is Base's router/pool/token — not our call shape.
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

const signer = await resolveSigner("base"); // same key/protocol address on both chains
const VALUE = 1997350161767056n;

const MAINNET = {
  router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  rpc: "https://eth-mainnet.g.alchemy.com/v2/" + (process.env.ALCHEMY_API_KEY || "").trim(),
};
const BASE = {
  router: "0x2626664c2603336E57B271c5C0b26F421741e481",
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  rpc: "https://mainnet.base.org",
};

async function test(tag, cfg, fee) {
  const p = {
    tokenIn: cfg.weth, tokenOut: cfg.usdc, fee, recipient: signer.address,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
  };
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [[
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [VALUE] }),
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [p] }),
    encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
  ]] });
  const res = await fetch(cfg.rpc, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ from: signer.address, to: cfg.router, data, value: "0x" + VALUE.toString(16) }, "latest"] }),
  });
  const j = await res.json();
  let note = "";
  if (j.error?.data?.startsWith?.("0x08c379a0")) {
    try { note = " → " + decodeAbiParameters(parseAbiParameters("string"), "0x" + j.error.data.slice(10))[0]; } catch {}
  }
  console.log(`${tag}:`, j.error ? "REVERT " + JSON.stringify(j.error).slice(0, 200) + note : "OK ✅  out=" + (j.result || "").slice(2, 66));
}

await test("mainnet WETH→USDC (fee 500)", MAINNET, 500);
await test("base    WETH→USDC (fee 500)", BASE, 500);
