import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { getChain, httpClient } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");
const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const dep = getChain("base");
const client = httpClient("base");
const signer = await resolveSigner("base");
const ABI = [{ name: "exactInputSingle", type: "function", stateMutability: "payable", inputs: [{ components: [
  { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" },
  { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" }, { name: "amountIn", type: "uint256" },
  { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" },
], type: "tuple" }], outputs: [{ type: "uint256" }] }];
async function sim(min, tag) {
  try {
    const gas = await client.estimateContractGas({
      address: dep.v3.swapRouter02, abi: ABI, functionName: "exactInputSingle",
      args: [{ tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
        amountIn: 1997350161767056n, amountOutMinimum: min, sqrtPriceLimitX96: 0n }],
      value: 1997350161767056n, account: signer.address,
    });
    console.log(`${tag}: OK gas=${gas}`);
    return true;
  } catch (e) {
    console.log(`${tag}: REVERT — ${(e.message.match(/revert reason[^\n]*|execution reverted[^\n]*|Details:[^\n]*/gi) || [e.message]).join(" | ").slice(0, 300)}`);
    return false;
  }
}
const okZero = await sim(0n, "min=0 (no slippage guard)");
if (okZero) {
  await sim(373266544989037702n, "min=0.373 (original min-out)");
} else {
  console.log("→ token blocks buys entirely (tax/honeypot or pool misconfigured), NOT a slippage issue");
}
