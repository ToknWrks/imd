/**
 * diag-robinhood-quote-rpc.mjs — compare quote calls across the public RPC vs
 * Alchemy on Robinhood, using dip-swap's own quoteSellV4 (the same call the
 * working buy path uses). Read-only, no transactions.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { quoteSellV4 } = await import("../dip-swap.mjs");
import { getChain } from "../chains.mjs";
import { findBestV4Pool } from "../dip-swap.mjs";

const token = process.argv[2] ?? "0x3b4a0048a00787a644932cd648faa043410c163e"; // SIRIUS
const chainKey = "robinhood";
const pool = await findBestV4Pool(token, chainKey);
if (!pool) { console.log("no V4 pool"); process.exit(0); }
console.log(`pool found: fee=${pool.fee} ts=${pool.tickSpacing} hooked=${pool.hooks} liqUsd=${pool.liquidityUsd}`);

const amountRaw = 174300000000000000000n / 100n; // 1% of 17430 SIRIUS

// Quote through dip-swap's client (its own httpClient + retry shape).
try {
  const out = await quoteSellV4(pool, amountRaw, chainKey);
  console.log("dip-swap quoteSellV4 OK:", out.toString());
} catch (e) {
  console.log("dip-swap quoteSellV4 ERR:", e.message.slice(0, 250));
}

// Raw eth_call against each RPC with viem-encoded data.
import { encodeFunctionData, parseAbi } from "viem";
const V4Q = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const data = encodeFunctionData({
  abi: V4Q,
  functionName: "quoteExactInputSingle",
  args: [{
    poolKey: { currency0: pool.poolKey.currency0, currency1: pool.poolKey.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks },
    zeroForOne: pool.poolKey.currency0.toLowerCase() === token.toLowerCase(),
    exactAmount: amountRaw,
    hookData: "0x",
  }],
});
const quoter = getChain("robinhood").v4.quoter;
for (const [name, url] of Object.entries(urls)) {
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: quoter, data }, "latest"] }),
    });
    const j = await r.json();
    console.log(`${name}: ${j.result ? "OK " + BigInt(j.result.slice(0, 66)).toString() : "ERR " + JSON.stringify(j.error ?? j).slice(0, 150)}`);
  } catch (e) { console.log(`${name}: FETCH ERR ${e.message.slice(0, 100)}`); }
}
