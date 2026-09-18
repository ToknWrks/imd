#!/usr/bin/env node
// diag-v3-swapdir.mjs — is the TOKEN the blocker, or the POOL/position?
// Test the simplest possible swap: plain V3 pool contract swap() called
// directly (no router, no token interaction). If this reverts, the POOL or
// token's pool-interaction hook is the problem. If it works, the ROUTER or
// token's router interaction is the problem.
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
const { encodeFunctionData, encodeAbiParameters, parseAbiParameters, getAddress } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const POOL = "0xA321D950082166d11DB11cFBd6e32A91e6144Ff0";
const WETH = getChain("base").weth;
const signer = await resolveSigner("base");
const VALUE = 1997350161767056n;

const rpcUrl = getChain("base").httpRpc();
async function rpc(method, params_) {
  const res = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params_ }),
  });
  return res.json();
}

// plain V3 swap: exactOutput-ish minimal — just do exactInputSingle semantics
// through the pool directly. uniswapV3SwapCallback needs fee + payer.
const SWAP_ABI = [{
  name: "swap", type: "function", stateMutability: "nonpayable",
  inputs: [
    { type: "address" }, { type: "bool" }, { type: "int256" }, { type: "uint160" },
    { type: "bytes" },
  ],
  outputs: [{ type: "int256" }, { type: "uint256" }],
}];
const data = encodeAbiParameters(parseAbiParameters("address, uint24"), [getAddress(signer.address), 10000n]);
const j = await rpc("eth_call", [{
  from: signer.address, to: POOL,
  data: encodeFunctionData({
    abi: SWAP_ABI, functionName: "swap",
    args: [signer.address, false, BigInt(VALUE), 0n, data],
  }),
}, "latest"]);
console.log("direct pool swap:", j.error ? "REVERT " + JSON.stringify(j.error).slice(0, 250) : "OK " + (j.result || "").slice(0, 100));

// also: does the pool actually have reserves? read slot0 + liquidity directly
const SLOT0 = "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 protocolFee, uint16 lpFee, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext)";
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];
const { createPublicClient, http: vhttp } = await import("viem");
const client = createPublicClient({ transport: vhttp(rpcUrl) });
try {
  const [s0, liq] = await Promise.all([
    client.readContract({ address: POOL, abi: POOL_ABI, functionName: "slot0" }),
    client.readContract({ address: POOL, abi: POOL_ABI, functionName: "liquidity" }),
  ]);
  console.log("pool slot0:", JSON.stringify(s0, (_, v) => typeof v === "bigint" ? v.toString() : v));
  console.log("pool liquidity:", liq.toString());
} catch (e) {
  console.log("pool read err:", e.message.slice(0, 200));
}

// and: WETH0 balance of the pool (does it have WETH to sell us tokens with?)
const wethBal = await client.readContract({
  address: WETH, abi: ["function balanceOf(address) view returns (uint256)"],
  functionName: "balanceOf", args: [POOL],
});
console.log("pool WETH balance:", Number(wethBal) / 1e18, "WETH");
const tokenBal = await client.readContract({
  address: TOKEN, abi: ["function balanceOf(address) view returns (uint256)"],
  functionName: "balanceOf", args: [POOL],
});
console.log("pool token balance:", Number(tokenBal) / 1e18, "LAPTOP");
