/**
 * What-if SIMULATION v3 (read-only, no trades): $200 trades on SIRIUS.
 * Quotes RAW through the V4 Quoter and computes price impact itself.
 */
import { readFileSync } from "fs";
const env = Object.fromEntries(readFileSync("/Users/lancepitman/accumulate/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.match(/^([^#=][^=]*)=(.*)$/)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const POOL_ID = "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b";
const SIRIUS = "0x3b4A0048a00787A644932cD648Faa043410C163e";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const poolKey = { currency0: SIRIUS, currency1: USDG, fee: 0, tickSpacing: 200, hooks: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" };

const { createPublicClient, http, parseAbi } = await import("viem");
const { getChain, getEthUsdPriceFor } = await import("../chains.mjs");
const dep = getChain("robinhood");
const c = createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc(), { batch: false, retryCount: 1 }) });

const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const STATE_VIEW_ABI = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint16 protocolFee, uint16 lpFee)"]);
const slot0 = await c.readContract({ address: dep.v4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [POOL_ID] });
const s = Number(slot0[0]) / 2 ** 96;
const spot = s * s * 10 ** (18 - 6); // USDG per SIRIUS (USDG ≈ $1)
console.log(`SIRIUS spot: ${spot.toPrecision(6)} USDG (~$${spot.toPrecision(6)})`);
console.log(`pool liq (dexscreener): ~$99,600\n`);
console.log("RAW V4 quoter simulation (avgExec vs spot):\n");
console.log("size      sirius out/in   avg buy $     buy imp%    sell imp%    vs 2% gate");
for (const usd of [10, 50, 100, 200, 500, 1000, 2000]) {
  // BUY: pay USDG (currency1) → receive SIRIUS (currency0): zeroForOne = false
  const usdgInRaw = BigInt(Math.round(usd * 1e6));
  let siriusOutRaw = 0n, usdgOutRaw = 0n, buyErr = null, sellErr = null;
  try {
    const r = await c.simulateContract({
      address: dep.v4.quoter, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
      args: [{ poolKey, zeroForOne: false, exactAmount: usdgInRaw, hookData: "0x" }],
    });
    siriusOutRaw = r.result[0];
  } catch (e) { buyErr = String(e.message ?? e).slice(0, 70); }
  // SELL: sell `usd` worth of SIRIUS → receive USDG, zeroForOne = true
  const siriusInRaw = BigInt(Math.round((usd / spot) * 1e18));
  try {
    const r = await c.simulateContract({
      address: dep.v4.quoter, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
      args: [{ poolKey, zeroForOne: true, exactAmount: siriusInRaw, hookData: "0x" }],
    });
    usdgOutRaw = r.result[0];
  } catch (e) { sellErr = String(e.message).slice(0, 70); }

  if (buyErr || sellErr || siriusOutRaw === 0n || usdgOutRaw === 0n) {
    console.log(`$${String(usd).padEnd(6)}  quote failed (buy: ${buyErr ?? "ok"}, sell: ${sellErr ?? "ok"})`);
    continue;
  }
  const siriusOut = Number(siriusOutRaw) / 1e18;
  const avgBuy = usd / siriusOut;
  const buyImp = (avgBuy / spot - 1) * 100;
  const usdgOut = Number(usdgOutRaw) / 1e6;
  const avgSell = usdgOut / (usd / spot);
  const sellImp = (1 - avgSell / spot) * 100;
  const worst = Math.max(buyImp, sellImp);
  const verdict = worst > 2 ? "BLOCKED" : "passes";
  console.log(`$${String(usd).padEnd(6)} ${siriusOut.toPrecision(7).padStart(13)} ${avgBuy.toPrecision(6).padStart(13)} ${buyImp.toFixed(3).padStart(11)} ${sellImp.toFixed(3).padStart(11)}    ${verdict}`);
}
process.exit(0);
