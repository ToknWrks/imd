/**
 * Per-trade sell-size evidence from The Graph subgraphs (V3 + V4).
 *
 * Zooch's dipThresholdUsd is a dollar sell size — the planning logic wants a
 * threshold that fires on real sells, not hypothetical ones. Before this
 * module the only evidence for "how big are sells actually" was the simulated
 * impact curve and Dexscreener txn counts (which carry no sizes). The Graph
 * Studio subgraphs provide actual per-trade USD sizes, so the threshold can
 * be set from the observed distribution.
 *
 * Sign convention (both subgraphs): amount0/amount1 are the pool's token
 * balance deltas. A SELL of the accumulated token pushes tokens INTO the
 * pool, so the token-side delta is POSITIVE. (Verified live: IMD V4 pool
 * shows {amount0: "-0.047", amount1: "+39.9"} for an IMD sell — ETH out,
 * IMD in.) ETH/currency0 always sorts first, but the accumulated token can
 * be either side in a WETH V3 pool, so direction is decided per-swap via
 * token0/token1 identity, never a hardcoded sign.
 *
 * Gated like every other optional feed: missing THEGRAPH_API_KEY, a Uniswap
 * dashboard key (gateway rejects it as "malformed"), an unreachable subgraph,
 * or no indexed pool → { status: "unavailable", error } and the review
 * proceeds without it. Requires a Graph **Studio** key
 * (thegraph.com/studio/apikeys) — a Uniswap dashboard key is a different
 * platform and does NOT work here.
 */
import { getAddress } from "viem";
import { findBestPool, findBestV4Pool } from "./dip-swap.mjs";
import { getGraphSubgraphs } from "./chains.mjs";

const GATEWAY = "https://gateway.thegraph.com/api";

const PAGE_SIZE = 1000;           // max swaps fetched per venue
const DEFAULT_WINDOW_HOURS = 72;  // lookback for the sell-size distribution

let lastRequestAt = 0;
let rateLimitedUntil = 0;

async function gql(subgraphId, query) {
  const key = process.env.THEGRAPH_API_KEY?.trim();
  if (!key) throw new Error("THEGRAPH_API_KEY not configured");
  const wait = Math.max(rateLimitedUntil - Date.now(), lastRequestAt + 250 - Date.now(), 0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  const response = await fetch(
    `${GATEWAY}/${key}/subgraphs/id/${subgraphId}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) }
  );
  if (response.status === 429) {
    rateLimitedUntil = Date.now() + 10_000;
    throw new Error("Graph gateway rate-limited (HTTP 429) — try again shortly");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Graph gateway HTTP ${response.status}${text ? `: ${text.slice(0, 140)}` : ""}`);
  }
  const body = await response.json();
  if (body.errors?.length) throw new Error(`Graph query error: ${body.errors[0].message}`);
  return body.data;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[idx];
}

const V3_SWAP_FIELDS = `
  amount0 amount1 amountUSD timestamp transaction { id }
  pool { token0 { id } token1 { id } }
`;
const V4_SWAP_FIELDS = `
  amount0 amount1 amountUSD timestamp transaction { id }
  pool { token0 { id } token1 { id } }
`;

/** V3 swap fields include amountUSD (verified live via scripts/test-graph.mjs). */
function extractSells(swaps, tokenLower, cutoffSec) {
  const sells = [];
  const buys = [];
  const largest = [];
  for (const s of swaps) {
    const ts = Number(s.timestamp ?? 0);
    if (cutoffSec && ts < cutoffSec) continue;
    const token0 = s.token0?.id ?? s.pool?.token0?.id;
    const token1 = s.token1?.id ?? s.pool?.token1?.id;
    const tokenDelta = token0?.toLowerCase() === tokenLower ? Number(s.amount0) : Number(s.amount1);
    if (!Number.isFinite(tokenDelta) || tokenDelta === 0) continue;
    const usd = Math.abs(Number(s.amountUSD ?? 0));
    if (!Number.isFinite(usd) || usd <= 0) continue;
    const entry = { usd, ts, tx: s.transaction?.id ?? null };
    if (tokenDelta > 0) { sells.push(usd); largest.push(entry); }
    else buys.push(usd);
  }
  largest.sort((a, b) => b.usd - a.usd);
  return { sells, buys, largest: largest.slice(0, 5) };
}

function summarizeSells(sells, buys, largest, windowHours, venueCount) {
  const sorted = [...sells].sort((a, b) => a - b);
  return {
    windowHours,
    venueCount,
    sellCount: sells.length,
    buyCount: buys.length,
    p50SellUsd: percentile(sorted, 50),
    p90SellUsd: percentile(sorted, 90),
    p95SellUsd: percentile(sorted, 95),
    maxSellUsd: sorted.length ? sorted[sorted.length - 1] : null,
    totalSellUsd: sells.reduce((sum, v) => sum + v, 0),
    largestRecentSells: largest,
  };
}

async function collectV3Sells(contractAddress, windowHours, chainKey) {
  const subgraphId = getGraphSubgraphs(chainKey)?.v3;
  if (!subgraphId) throw new Error(`no verified Graph V3 subgraph id for chain "${chainKey}"`);
  const pool = await findBestPool(getAddress(contractAddress), chainKey);
  if (!pool?.address) return null; // no V3 pool — not an error, just no venue
  const cutoffSec = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const data = await gql(subgraphId, `{
    swaps(first: ${PAGE_SIZE}, orderBy: timestamp, orderDirection: desc,
          where: { pool: "${pool.address.toLowerCase()}", timestamp_gte: ${cutoffSec} }) {
      ${V3_SWAP_FIELDS}
    }
  }`);
  const { sells, buys, largest } = extractSells(data?.swaps ?? [], getAddress(contractAddress).toLowerCase(), cutoffSec);
  return { kind: "v3", address: pool.address, fee: pool.fee, _sells: sells, _buys: buys, ...extractSellsMeta(sells, buys, largest) };
}

async function collectV4Sells(contractAddress, windowHours, chainKey) {
  const subgraphId = getGraphSubgraphs(chainKey)?.v4;
  if (!subgraphId) throw new Error(`no verified Graph V4 subgraph id for chain "${chainKey}"`);
  const pool = await findBestV4Pool(getAddress(contractAddress), chainKey);
  if (!pool?.poolId) return null;
  const cutoffSec = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const data = await gql(subgraphId, `{
    swaps(first: ${PAGE_SIZE}, orderBy: timestamp, orderDirection: desc,
          where: { pool: "${pool.poolId.toLowerCase()}", timestamp_gte: ${cutoffSec} }) {
      ${V4_SWAP_FIELDS}
    }
  }`);
  const { sells, buys, largest } = extractSells(data?.swaps ?? [], getAddress(contractAddress).toLowerCase(), cutoffSec);
  return { kind: "v4", poolId: pool.poolId, _sells: sells, _buys: buys, ...extractSellsMeta(sells, buys, largest) };
}

function extractSellsMeta(sells, buys, largest) {
  const sorted = [...sells].sort((a, b) => a - b);
  return {
    sellCount: sells.length,
    buyCount: buys.length,
    p50SellUsd: percentile(sorted, 50),
    p90SellUsd: percentile(sorted, 90),
    p95SellUsd: percentile(sorted, 95),
    maxSellUsd: sorted.length ? sorted[sorted.length - 1] : null,
    totalSellUsd: sells.reduce((sum, v) => sum + v, 0),
    largestRecentSells: largest,
  };
}

/**
 * Collect per-trade sell-size evidence across the token's best V3 + V4 pools.
 * @returns {Promise<{ status: "unavailable", error: string } |
 *                    { status: "available", source: string, windowHours: number,
 *                      venues: object[], sellCount, buyCount, p50SellUsd,
 *                      p90SellUsd, p95SellUsd, maxSellUsd, totalSellUsd,
 *                      largestRecentSells }>}
 */
export async function collectGraphTradeEvidence(contractAddress, { windowHours = DEFAULT_WINDOW_HOURS, chainKey = "ethereum" } = {}) {
  try {
    const token = getAddress(contractAddress);
    const venues = (await Promise.all([
      collectV3Sells(token, windowHours, chainKey).catch((e) => ({ kind: "v3", error: e.message })),
      collectV4Sells(token, windowHours, chainKey).catch((e) => ({ kind: "v4", error: e.message })),
    ])).filter(Boolean);

    const usable = venues.filter((v) => !v.error);
    if (!usable.length) {
      const error = venues.map((v) => `${v.kind}: ${v.error}`).join("; ") || "no Uniswap V3/V4 pool found";
      return { status: "unavailable", source: "thegraph-subgraphs", error };
    }

    const allSells = usable.flatMap((v) => v._sells ?? []);
    const allBuys = usable.flatMap((v) => v._buys ?? []);
    const largest = usable
      .flatMap((v) => v.largestRecentSells ?? [])
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5);

    const summary = extractSellsMeta(allSells, allBuys, largest);
    return {
      status: "available",
      source: "thegraph-subgraphs",
      collectedAt: new Date().toISOString(),
      windowHours,
      venues: usable.map(({ _sells, _buys, ...rest }) => {
        void _sells; void _buys;
        return rest;
      }),
      ...summary,
    };
  } catch (error) {
    return { status: "unavailable", source: "thegraph-subgraphs", error: error.message };
  }
}
