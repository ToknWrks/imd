#!/usr/bin/env node
// diag-v3-isolate.mjs — get the REAL revert reason for the multicall buy path.
// Tries multicall with min=0, then raw eth_call to capture revert bytes,
// and decodes known SwapRouter revert selectors.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { ROUTER_ABI, quoteBuy } = await import("../dip-swap.mjs");
const { getChain, httpClient } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");
const { encodeFunctionData } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const dep = getChain("base");
const client = httpClient("base");
const signer = await resolveSigner("base");
const VALUE = 1997350161767056n;

function params(min) {
  return {
    tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    amountIn: VALUE, amountOutMinimum: min, sqrtPriceLimitX96: 0n,
  };
}
function multicallData(min) {
  return encodeFunctionData({
    abi: ROUTER_ABI, functionName: "multicall",
    args: [[
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [VALUE] }),
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params(min)] }),
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
    ]],
  });
}

// raw eth_call — surfaces revert bytes instead of viem's generic message
async function rawCall(data, tag) {
  const from = signer.address;
  try {
    const res = await client.request({ method: "eth_call", params: [{ from, to: dep.v3.swapRouter02, data, value: "0x" + VALUE.toString(16) }, "latest"] });
    console.log(`${tag}: OK ${res.slice(0, 66)}`);
    return true;
  } catch (e) {
    const m = (e.message || "").match(/data\s*"?0x[0-9a-fA-F]+/);
    console.log(`${tag}: REVERT data=${m ? m[0].slice(5) : "(none)"} msg=${(e.message || "").slice(0, 200)}`);
    return false;
  }
}

const ok0 = await rawCall(multicallData(0n), "multicall min=0");
if (ok0) {
  const q = await quoteBuy(TOKEN, 10000, VALUE, "base");
  const min = q - (q * 300n) / 10000n;
  await rawCall(multicallData(min), `multicall min=${min}`);
} else {
  console.log("→ even with zero slippage guard the multicall reverts — inner swap logic itself fails");
  console.log("  known selectors: 0x08c379a0=Error(string) 0x4e487b71=Panic 0xfa05468c=TooLittleReceived 0x316cfceb=... ");
}
