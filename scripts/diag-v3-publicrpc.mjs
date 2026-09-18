#!/usr/bin/env node
// diag-v3-publicrpc.mjs — retry revert-data capture via base public RPC,
// which tends to return revert data where Alchemy strips it.
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

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const dep = getChain("base");
const signer = await resolveSigner("base");
const VALUE = 1997350161767056n;

const swapParams = {
  tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
};
const calls = {
  "router multicall": { to: dep.v3.swapRouter02, value: "0x" + VALUE.toString(16), data: encodeFunctionData({
    abi: ROUTER_ABI, functionName: "multicall",
    args: [[
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [VALUE] }),
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [swapParams] }),
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
    ]],
  }) },
  "direct exactInputSingle (wallet-funded)": { to: dep.v3.swapRouter02, value: "0x" + VALUE.toString(16), data: encodeFunctionData({
    abi: ROUTER_ABI, functionName: "exactInputSingle", args: [swapParams],
  }) },
};

for (const rpcUrl of ["https://mainnet.base.org", dep.httpRpc()]) {
  for (const [tag, c] of Object.entries(calls)) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: signer.address, ...c }, "latest"] }),
      });
      const j = await res.json();
      if (j.error) {
        const d = j.error.data ?? "";
        let msg = "";
        if (typeof d === "string" && d.startsWith("0x08c379a0")) {
          try { msg = " → " + decodeAbiParameters(parseAbiParameters("string"), "0x" + d.slice(10))[0]; } catch {}
        }
        console.log(`[${rpcUrl.slice(8, 30)}] ${tag}: REVERT ${typeof d === "string" ? d.slice(0, 160) : ""}${msg}`);
      } else {
        console.log(`[${rpcUrl.slice(8, 30)}] ${tag}: OK`);
      }
    } catch (e) {
      console.log(`[${rpcUrl.slice(8, 30)}] ${tag}: RPC error ${e.message.slice(0, 120)}`);
    }
  }
}
