#!/usr/bin/env node
// diag-v3-facts.mjs — hard facts: is the SwapRouter02 address real? what
// WETH does it reference? does a WORKING control swap exist? what does the
// LAPTOP pool actually hold?
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
const { encodeFunctionData, parseAbi, createPublicClient, http } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const POOL = "0xA321D950082166d11DB11cFBd6e32A91e6144Ff0";
const dep = getChain("base");
const signer = await resolveSigner("base");
const VALUE = 1997350161767056n;
const SWAPR = dep.v3.swapRouter02;

const client = createPublicClient({ transport: http(dep.httpRpc()) });
const code = await client.getBytecode({ address: SWAPR });
console.log("SwapRouter02 bytecode size:", (code?.length ?? 0) / 2 - 1, "bytes");

const view = parseAbi(["function WETH9() view returns (address)", "function factory() view returns (address)"]);
console.log("router.WETH9():", await client.readContract({ address: SWAPR, abi: view, functionName: "WETH9" }));
console.log("router.factory():", await client.readContract({ address: SWAPR, abi: view, functionName: "factory" }));

const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const usdcPool500 = await client.readContract({ address: dep.v3.factory, abi: factoryAbi, functionName: "getPool", args: [dep.dollar, dep.weth, 500] });
console.log("factory USDC/WETH fee500 pool:", usdcPool500);

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const [poolWeth, poolTok] = await Promise.all([
  client.readContract({ address: dep.weth, abi: ERC20, functionName: "balanceOf", args: [POOL] }),
  client.readContract({ address: TOKEN, abi: ERC20, functionName: "balanceOf", args: [POOL] }),
]);
console.log(`LAPTOP pool reserves: ${Number(poolWeth) / 1e18} WETH · ${Number(poolTok) / 1e18} LAPTOP`);

// control: if a USDC/WETH pool exists, quote then swap via router multicall
if (usdcPool500 !== "0x0000000000000000000000000000000000000000") {
  try {
    const q = await quoteBuy(dep.dollar, 500, VALUE, "base");
    console.log("control quote WETH→USDC:", (Number(q) / 1e6).toFixed(2), "USDC");
    const p = {
      tokenIn: dep.weth, tokenOut: dep.dollar, fee: 500, recipient: signer.address,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
      amountIn: VALUE, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    };
    const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [[
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "wrapETH", args: [VALUE] }),
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [p] }),
      encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }),
    ]] });
    const res = await fetch(dep.httpRpc(), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: signer.address, to: SWAPR, data, value: "0x" + VALUE.toString(16) }, "latest"] }),
    });
    const j = await res.json();
    console.log("control swap WETH→USDC multicall:", j.error ? "REVERT " + JSON.stringify(j.error).slice(0, 300) : "OK ✅");
  } catch (e) {
    console.log("control quote failed:", e.message.slice(0, 200));
  }
}
