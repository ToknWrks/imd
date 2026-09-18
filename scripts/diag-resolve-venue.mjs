/**
 * diag-resolve-sell-venue.mjs — read-only rehearsal of the new sell-venue
 * resolution for every watched token: calls the same dip-swap resolvers
 * (findBestV4Pool, findBestV3DollarPool, findBestPool) that resolveSellVenue
 * uses, then runs the sell-side quote simulation and allowance checks.
 * Sends NO transactions.
 */
import * as db from "../db.mjs";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getChain } from "../chains.mjs";
import { findBestV4Pool, findBestV3DollarPool, findBestPool, getErc20Balance } from "../dip-swap.mjs";
import { publicClient, getTokenMeta, getNetwork } from "../sniper-swap.mjs";
import { parseAbi } from "viem";

const wallet = process.argv[2] ?? "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";

// Load .env (same pattern as dip-watcher/dashboard) — Robinhood 403s on the
// public RPC; only Alchemy works there.
function loadEnv() {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
  try {
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "").replace(/\s*#.*$/, "");
    }
  } catch {}
}
loadEnv();

const V3_QUOTE_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const V4_QUOTE_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

for (const w of db.getDipWatchers()) {
  const chainKey = w.chain || "ethereum";
  const token = w.contract_address;
  const label = `${w.symbol} (${chainKey})`;
  const lines = [];
  try {
    const meta = await getTokenMeta(chainKey, token);
    // getErc20Balance returns a RAW (wei-scale) string — take 1% as bigint.
    // The public Robinhood RPC 403s sporadically — retry a few times.
    let balRaw = 0n;
    for (let i = 0; i < 5 && balRaw === 0n; i++) {
      balRaw = BigInt(await getErc20Balance(token, wallet, chainKey).catch(() => "0"));
      if (balRaw === 0n) await new Promise((r) => setTimeout(r, 1500));
    }
    if (balRaw <= 0n) { console.log(`${label}: wallet balance 0 after retries — skipping quote`); continue; }
    const amountIn = balRaw / 100n; // 1%
    if (amountIn <= 0n) { console.log(`${label}: wallet balance 0 — skipping quote`); continue; }

    const [v4, v3Dollar] = await Promise.all([
      findBestV4Pool(token, chainKey).catch((e) => ({ error: e.message })),
      findBestV3DollarPool(token, chainKey).catch((e) => ({ error: e.message })),
    ]);
    let v3 = null;
    try { v3 = await findBestPool(token, chainKey); } catch {}

    if (v4 && !v4.error) {
      const n = getNetwork(chainKey);
      const tokenIs0 = v4.currency0.toLowerCase() === token.toLowerCase();
      try {
        const { result } = await publicClient(chainKey).simulateContract({
          address: n.v4Quoter, abi: V4_QUOTE_ABI, functionName: "quoteExactInputSingle",
          args: [{
            poolKey: { currency0: v4.currency0, currency1: v4.currency1, fee: v4.fee, tickSpacing: v4.tickSpacing, hooks: v4.hooks },
            zeroForOne: tokenIs0,
            exactAmount: amountIn,
            hookData: "0x",
          }],
        });
        lines.push(`  V4 WINNER liqUsd=${v4.liquidityUsd} fee=${v4.fee} ts=${v4.tickSpacing} hooked=${v4.hooks !== "0x0000000000000000000000000000000000000000"} quoteOut=${result[0].toString()} zeroForOne=${tokenIs0}`);
      } catch (e) { lines.push(`  V4 found (liqUsd=${v4.liquidityUsd}) but QUOTE FAILED: ${e.message.slice(0, 160)}`); }
    } else lines.push(`  V4: none${v4?.error ? ` (${v4.error.slice(0, 80)})` : ""}`);

    if (v3Dollar && !v3Dollar.error) {
      const dollar = getChain(chainKey).dollar;
      try {
        const { result } = await publicClient(chainKey).simulateContract({
          address: getNetwork(chainKey).v3Quoter, abi: V3_QUOTE_ABI, functionName: "quoteExactInputSingle",
          args: [{ tokenIn: token, tokenOut: dollar, amountIn, fee: Number(v3Dollar.fee), sqrtPriceLimitX96: 0n }],
        });
        lines.push(`  V3_DOLLAR liqUsd=${v3Dollar.liquidityUsd} fee=${v3Dollar.fee} pool=${v3Dollar.address} quoteOut=${result[0].toString()}`);
      } catch (e) { lines.push(`  V3_DOLLAR found (liqUsd=${v3Dollar.liquidityUsd}) but QUOTE FAILED: ${e.message.slice(0, 160)}`); }
    } else lines.push(`  V3_DOLLAR: none${v3Dollar?.error ? ` (${v3Dollar.error.slice(0, 80)})` : ""}`);

    if (v3) lines.push(`  V3_WETH fee=${v3.fee} pool=${v3.address} (fallback candidate)`);
    else lines.push(`  V3_WETH: none`);

    console.log(`\n=== ${label} — sell 1% of balance ===`);
    for (const l of lines) console.log(l);
  } catch (e) {
    console.log(`\n=== ${label} — DIAG FAILED: ${e.message.slice(0, 200)}`);
  }
}
