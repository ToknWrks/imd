#!/usr/bin/env node
// diag-v3-override.mjs — DECISIVE test: does the swap work if the wallet
// HOLDS WETH? Uses eth_call state overrides (stateDiff on WETH's balanceOf
// mapping slot for the wallet). Also tests each router shape so we know
// exactly which pattern works with a funded wallet vs without.
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
const { encodeFunctionData, keccak256, encodeAbiParameters, parseAbiParameters, pad, toHex } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const dep = getChain("base");
const signer = await resolveSigner("base");
const VALUE = 1997350161767056n;
const WETH = dep.weth;

// WETH9 balanceOf mapping lives at storage slot 3
const slot = keccak256(encodeAbiParameters(parseAbiParameters("address, uint256"), [signer.address, 3n]));
const hugeBal = pad(toHex(1000n * 10n ** 18n), { size: 32 });

const swapParams = (min = 0n) => ({
  tokenIn: WETH, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
  amountIn: VALUE, amountOutMinimum: min, sqrtPriceLimitX96: 0n,
});

const variants = {
  "plain exactInputSingle{value}": { to: dep.v3.swapRouter02, value: "0x" + VALUE.toString(16), data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [swapParams()] }) },
  "multicall(wrap+swap+refund){value}": { to: dep.v3.swapRouter02, value: "0x" + VALUE.toString(16), data: encodeFunctionData({
    abi: ROUTER_ABI, functionName: "multicall",
    args: [[
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [VALUE] }),
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [swapParams()] }),
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
    ]],
  }) },
};

for (const [tag, c] of Object.entries(variants)) {
  for (const funded of [false, true]) {
    const params_ = [{ from: signer.address, ...c }, "latest"];
    if (funded) params_.push({ [WETH]: { stateDiff: { [slot]: hugeBal } } });
    try {
      const res = await fetch("https://mainnet.base.org", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: signer.address, ...c }, "latest", ...(funded ? [{ [WETH]: { stateDiff: { [slot]: hugeBal } } }] : [])] }),
      });
      const j = await res.json();
      const t = `${tag} ${funded ? "WALLET-FUNDED-WETH" : "wallet-empty-WETH "}`;
      console.log(`${t}:`, j.error ? "REVERT " + String(j.error.data ?? "").slice(0, 140) : "OK ✅");
    } catch (e) {
      console.log(`${tag} funded=${funded}: RPC error ${e.message.slice(0, 100)}`);
    }
  }
}
