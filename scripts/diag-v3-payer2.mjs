#!/usr/bin/env node
// diag-v3-payer2.mjs — decode the exact from/to/amount of the failing WETH
// transferFrom in the Base trace, and check wallet WETH balances on both chains.
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
const { encodeFunctionData, parseAbi, decodeFunctionData, createPublicClient, http } = await import("viem");

const signer = await resolveSigner("base");
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

// wallet WETH balance on both chains
for (const [name, chainKey, rpc, weth] of [
  ["mainnet", "ethereum", "https://eth-mainnet.g.alchemy.com/v2/" + (process.env.ALCHEMY_API_KEY || "").trim(), "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"],
  ["base", "base", "https://mainnet.base.org", "0x4200000000000000000000000000000000000006"],
]) {
  const c = createPublicClient({ transport: http(rpc) });
  const bal = await c.readContract({ address: weth, abi: ERC20, functionName: "balanceOf", args: [signer.address] });
  console.log(`wallet WETH on ${name}:`, Number(bal) / 1e18);
}

// decode the failing transferFrom calldata from the Base trace
const dep = getChain("base");
const VALUE = 1997350161767056n;
const ROUTER_ABI_V2 = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function wrapETH(uint256 value) payable",
  "function refundETH() payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);
const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const p7 = {
  tokenIn: dep.weth, tokenOut: TOKEN, fee: 10000, recipient: signer.address,
  amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
};
const data = encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "multicall", args: [[
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "wrapETH", args: [VALUE] }),
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "exactInputSingle", args: [p7] }),
  encodeFunctionData({ abi: ROUTER_ABI_V2, functionName: "refundETH" }),
]] });

const res = await fetch("https://base.drpc.org", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debug_traceCall",
    params: [{ from: signer.address, to: dep.v3.swapRouter02, data, value: "0x" + VALUE.toString(16) }, "latest", { tracer: "callTracer" }] }),
});
const j = await res.json();
let tf = null;
const walk = (n) => {
  if ((n.input || "").startsWith("0x23b872dd") && n.error) tf = n;
  for (const c of n.calls || []) walk(c);
};
walk(j.result);
if (tf) {
  const { args } = decodeFunctionData({
    abi: parseAbi(["function transferFrom(address from,address to,uint256 amount)"]),
    data: tf.input,
  });
  console.log("\nfailing transferFrom on base:");
  console.log("  from:", args[0]);
  console.log("  to:  ", args[1]);
  console.log("  amount:", args[2].toString());
  console.log("  wallet:", signer.address.toLowerCase());
  console.log("  router:", dep.v3.swapRouter02.toLowerCase());
  console.log("  → payer is:", args[0].toLowerCase() === signer.address.toLowerCase() ? "THE WALLET" : args[0].toLowerCase() === dep.v3.swapRouter02.toLowerCase() ? "THE ROUTER" : "other");
}
