/**
 * Zooch market analysis — price-impact simulation and technical indicators.
 *
 * - Price impact: simulate sells of increasing size through the real pool
 *   quoters (Uniswap V4 quoter / V3 QuoterV2) to answer "how many $ of selling
 *   moves the price x%". No heuristics — actual swap math against live pools.
 * - Technicals: OHLCV candles from GeckoTerminal's free API → SMA, RSI(14),
 *   realized volatility, drawdown, and trend classification.
 */
import { getAddress, parseAbi, formatUnits } from "viem";
import {
  findBestPool, findBestV4Pool, quoteSellV3, quoteSellV4, getV4SpotPriceEth,
  getEthUsdPrice, getTokenSpotPriceEth,
} from "./dip-swap.mjs";
import { getChain } from "./chains.mjs";

// ── Price impact simulation ───────────────────────────────────────────────────

/**
 * Simulate sells of increasing USD size through the token's best pool and
 * measure the resulting price move (execution-price deterioration vs spot).
 */
export async function simulateSellImpact(contractAddress, tokenDecimals = 18, sizesUsd = [100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000], chainKey = "ethereum") {
  try {
    const v4 = await findBestV4Pool(contractAddress, chainKey).catch(() => null);
    const v3 = v4 ? null : await findBestPool(contractAddress, chainKey).catch(() => null);
    const ethUsd = await getEthUsdPrice(chainKey);
    const token = getAddress(contractAddress);

    let venue, quoteSell, spotEth;
    if (v4) {
      venue = { kind: "v4", poolId: v4.poolId, liquidityUsd: v4.liquidityUsd, fee: v4.fee, tickSpacing: v4.tickSpacing };
      quoteSell = (raw) => quoteSellV4(v4, raw, chainKey);
      spotEth = await getV4SpotPriceEth(v4, tokenDecimals, chainKey);
    } else if (v3) {
      const wethIsToken0 = v3.token0?.toLowerCase() === getChain(chainKey).weth.toLowerCase();
      venue = { kind: "v3", address: v3.address, fee: v3.fee, liquidity: v3.liquidity?.toString?.() ?? null };
      quoteSell = (raw) => quoteSellV3(token, v3.fee, raw, chainKey);
      spotEth = await getTokenSpotPriceEth({ poolAddress: v3.address, wethIsToken0, tokenDecimals }, null, chainKey);
    } else {
      return { error: "no Uniswap pool found for this token" };
    }

    const spotPriceUsd = spotEth * ethUsd;
    if (!(spotPriceUsd > 0)) return { error: "could not determine spot price" };

    const points = [];
    for (const sizeUsd of sizesUsd) {
      const tokenAmount = sizeUsd / spotPriceUsd;
      const raw = BigInt(Math.round(tokenAmount * 10 ** tokenDecimals));
      try {
        const ethOut = Number(await quoteSell(raw)) / 1e18;
        const wholeTokens = Number(raw) / 10 ** tokenDecimals;
        const effectivePrice = wholeTokens > 0 ? (ethOut * ethUsd) / wholeTokens : 0;
        const impactPct = spotPriceUsd > 0 ? ((spotPriceUsd - effectivePrice) / spotPriceUsd) * 100 : 0;
        points.push({ sellUsd: sizeUsd, impactPct: Math.round(impactPct * 100) / 100 });
      } catch (e) {
        points.push({ sellUsd: sizeUsd, impactPct: null, note: "beyond pool depth" });
        break;
      }
    }
    return { venue, ethUsd, spotPriceUsd, points };
  } catch (e) {
    return { error: e.message };
  }
}

// ── OHLCV candles (GeckoTerminal free API) ────────────────────────────────────

const GT_BASE = "https://api.geckoterminal.com/api/v2";
let gtLastRequestAt = 0;
let gtRetryAfterUntil = 0;
const GT_CACHE = new Map(); // key -> { at, value }
const GT_CACHE_TTL_MS = 10 * 60_000;

async function gt(path) {
  const cached = GT_CACHE.get(path);
  if (cached && Date.now() - cached.at < GT_CACHE_TTL_MS) return cached.value;
  const wait = Math.max(gtLastRequestAt + 350 - Date.now(), gtRetryAfterUntil - Date.now(), 0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  gtLastRequestAt = Date.now();
  const res = await fetch(`${GT_BASE}${path}`, { headers: { Accept: "application/json" } });
  if (res.status === 429) {
    // Honor Retry-After when present; default 60s. Serve a stale cache if we have one.
    const retryAfter = Number(res.headers.get("retry-after")) * 1000;
    gtRetryAfterUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60_000);
    if (cached) return cached.value;
    throw new Error("GeckoTerminal rate-limited (HTTP 429)");
  }
  if (!res.ok) throw new Error(`GeckoTerminal request failed: HTTP ${res.status}`);
  const value = await res.json();
  GT_CACHE.set(path, { at: Date.now(), value });
  return value;
}

/**
 * Fetch daily OHLCV candles for the token's highest-liquidity pool.
 * @returns {Promise<Array<{t:number,o:number,h:number,l:number,c:number,v:number}>>} oldest→newest
 */
export async function getDailyCandles(contractAddress, days = 30, chainKey = "ethereum") {
  const network = getChain(chainKey).geckoTerminal;
  if (!network) throw new Error(`GeckoTerminal has no listing for chain "${chainKey}"`);
  const pairs = await gt(`/networks/${network}/tokens/${getAddress(contractAddress)}/pools?page=1`);
  const pool = (pairs?.data ?? []).map((p) => p.attributes)
    .sort((a, b) => (b.reserve_in_usd ?? 0) - (a.reserve_in_usd ?? 0))[0];
  if (!pool) throw new Error("no pool found on GeckoTerminal");
  const ohlcv = await gt(`/networks/${network}/pools/${pool.address}/ohlcv/day?aggregate=1&limit=${Math.min(days, 1000)}&currency=usd`);
  const rows = ohlcv?.data?.attributes?.ohlcv_list ?? [];
  return rows.map((row) => ({ t: row[0], o: row[1], h: row[2], l: row[3], c: row[4], v: row[5] }))
    .sort((a, b) => a.t - b.t);
}

// ── Technical indicators ──────────────────────────────────────────────────────

/** Simple moving average of the last `n` closes. */
export function sma(closes, n) {
  if (closes.length < n) return null;
  const slice = closes.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

/** Wilder's RSI on close prices. */
export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change; else losses -= change;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Annualization-free realized volatility: stdev of daily log returns, in %. */
export function realizedVolPct(closes) {
  if (closes.length < 3) return null;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * 100;
}

function maxDrawdownPct(closes) {
  let peak = closes[0] ?? 0, mdd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    if (peak > 0) mdd = Math.max(mdd, ((peak - c) / peak) * 100);
  }
  return mdd;
}

/** Classify the daily trend from SMA relationships and momentum. */
function classifyTrend(closes) {
  const sma7 = sma(closes, 7);
  const sma20 = sma(closes, 20);
  const last = closes[closes.length - 1];
  let label = "rangebound";
  if (sma7 != null && sma20 != null) {
    if (sma7 > sma20 * 1.02 && last > sma7) label = "uptrend";
    else if (sma7 < sma20 * 0.98 && last < sma7) label = "downtrend";
  }
  return { label, sma7, sma20, sma50: sma(closes, 50), last };
}

/** Full technical snapshot from daily candles. */
export function computeTechnicals(candles) {
  const closes = candles.map((c) => c.c);
  if (closes.length < 8) return { error: "insufficient candle history" };
  const rsi14 = rsi(closes, 14);
  const trend = classifyTrend(closes);
  return {
    candleCount: closes.length,
    lastPriceUsd: closes[closes.length - 1],
    sma7: trend.sma7,
    sma20: trend.sma20,
    sma50: trend.sma50,
    trend: trend.label,
    rsi14: rsi14 != null ? Math.round(rsi14 * 10) / 10 : null,
    realizedVolPctDaily: realizedVolPct(closes) != null ? Math.round(realizedVolPct(closes) * 100) / 100 : null,
    maxDrawdownPct: Math.round(maxDrawdownPct(closes) * 100) / 100,
    change7dPct: closes.length >= 8 ? Math.round(((closes[closes.length - 1] / closes[closes.length - 8]) - 1) * 1000) / 10 : null,
    change30dPct: closes.length >= 30 ? Math.round(((closes[closes.length - 1] / closes[closes.length - 30]) - 1) * 1000) / 10 : null,
  };
}

/** Convenience wrapper: fetch candles and compute technicals in one call. */
export async function analyzeTechnicals(contractAddress, days = 30, chainKey = "ethereum") {
  try {
    const candles = await getDailyCandles(contractAddress, days, chainKey);
    const technicals = computeTechnicals(candles);
    return { source: "geckoterminal-daily", technicals };
  } catch (e) {
    return { source: "geckoterminal-daily", technicals: { error: e.message } };
  }
}
