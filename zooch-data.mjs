/**
 * Zooch on-chain evidence collection — Dexscreener-first.
 *
 * Market evidence comes from Dexscreener's token-pairs endpoint: one API call
 * returns every DEX venue a token trades on (Uniswap V2/V3/V4 and others) with
 * liquidity, volume windows, buy/sell transaction counts, and price momentum.
 * This replaced the old Alchemy log-scanning approach, which (a) only saw the
 * tiny V3 pool while the real market lives on V4, and (b) burned 160+ log
 * requests / ~48s per review to cover a sliver of one V3 pool.
 *
 * Holder/whale evidence needs a token-holder indexer. Alchemy's
 * alchemy_getTokenHolders is tier-gated (HTTP 400 on free keys), so those
 * metrics report "unavailable" honestly rather than guessing. If the Alchemy
 * plan is upgraded, holder data flows again with no other changes needed.
 */
import { formatUnits, getAddress, parseAbi } from "viem";
import { getPublicClient, getEthUsdPrice } from "./dip-swap.mjs";
import { getChain } from "./chains.mjs";

const MAX_HOLDERS = 20;
const MAX_WHALES = 10;
const ERC20_SUPPLY_ABI = parseAbi(["function totalSupply() view returns (uint256)"]);

// ── Dexscreener (300 req/min limit — pace defensively) ───────────────────────

const DEXSCREENER_BASE = "https://api.dexscreener.com";
let dsLastRequestAt = 0;
let dsRateLimitedUntil = 0;

async function dexscreener(path) {
  const wait = Math.max(dsRateLimitedUntil - Date.now(), dsLastRequestAt + 250 - Date.now(), 0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  dsLastRequestAt = Date.now();
  const response = await fetch(`${DEXSCREENER_BASE}${path}`);
  if (response.status === 429) {
    dsRateLimitedUntil = Date.now() + 5_000;
    throw new Error("Dexscreener rate-limited (HTTP 429) — try again shortly");
  }
  if (!response.ok) throw new Error(`Dexscreener request failed: HTTP ${response.status}`);
  return response.json();
}

/**
 * Every DEX venue a token trades on, with liquidity / volume / txn counts.
 * Sorted by liquidity, highest first.
 */
export async function getMarketOverview(tokenAddress, chainKey = "ethereum") {
  const token = getAddress(tokenAddress).toLowerCase();
  const pairs = await dexscreener(`/token-pairs/v1/${getChain(chainKey).dexscreener}/${token}`);
  if (!Array.isArray(pairs) || !pairs.length) throw new Error(`No DEX venues found for ${token}`);
  const venues = pairs.map((p) => ({
    dex: p.dexId ?? "unknown",
    labels: p.labels ?? [],
    pairAddress: p.pairAddress ?? null,
    isV4: (p.labels ?? []).includes("v4"),
    quoteSymbol: p.quoteToken?.symbol ?? "?",
    priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
    liquidityUsd: p.liquidity?.usd != null ? Number(p.liquidity.usd) : null,
    volume: {
      m5: p.volume?.m5 != null ? Number(p.volume.m5) : null,
      h1: p.volume?.h1 != null ? Number(p.volume.h1) : null,
      h6: p.volume?.h6 != null ? Number(p.volume.h6) : null,
      h24: p.volume?.h24 != null ? Number(p.volume.h24) : null,
    },
    txns: {
      m5: p.txns?.m5 ?? null,
      h1: p.txns?.h1 ?? null,
      h6: p.txns?.h6 ?? null,
      h24: p.txns?.h24 ?? null,
    },
    priceChange: {
      h1: p.priceChange?.h1 != null ? Number(p.priceChange.h1) : null,
      h6: p.priceChange?.h6 != null ? Number(p.priceChange.h6) : null,
      h24: p.priceChange?.h24 != null ? Number(p.priceChange.h24) : null,
    },
    pairCreatedAt: p.pairCreatedAt ?? null,
  }));
  return venues.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
}

/** Roll venue rows into the aggregate market windows Zooch reasons about. */
function summarizeVenues(venues) {
  const primary = venues[0];
  const sum = (pick) => venues.reduce((acc, v) => acc + (pick(v) ?? 0), 0);
  const txnsSum = (window) => venues.reduce((acc, v) => {
    const t = v.txns?.[window];
    return t ? { buys: acc.buys + (t.buys ?? 0), sells: acc.sells + (t.sells ?? 0) } : acc;
  }, { buys: 0, sells: 0 });
  return {
    venueCount: venues.length,
    primaryVenue: primary ? {
      dex: primary.dex, pairAddress: primary.pairAddress, quoteSymbol: primary.quoteSymbol,
      liquidityUsd: primary.liquidityUsd, isV4: primary.isV4,
    } : null,
    totalLiquidityUsd: sum((v) => v.liquidityUsd),
    volume: {
      m5: sum((v) => v.volume.m5),
      h1: sum((v) => v.volume.h1),
      h6: sum((v) => v.volume.h6),
      h24: sum((v) => v.volume.h24),
    },
    txns: { m5: txnsSum("m5"), h1: txnsSum("h1"), h6: txnsSum("h6"), h24: txnsSum("h24") },
    priceUsd: primary?.priceUsd ?? null,
    priceChange: primary?.priceChange ?? { h1: null, h6: null, h24: null },
  };
}

// ── Holder / whale evidence (holder indexer required) ─────────────────────────

function holderUnavailable(message) {
  return {
    status: "unavailable",
    source: "token-holder-indexer",
    holderCount: null,
    sampledTopHolderCount: 0,
    topHolderSupplyPct: null,
    whaleDefinition: "unavailable",
    whaleCount: null,
    whaleActivity: null,
    error: message,
  };
}

async function collectHolderEvidence(contractAddress, decimals, chainKey = "ethereum") {
  // alchemy_getTokenHolders is tier-gated on Alchemy (HTTP 400 on free keys).
  // Kept behind a clean try/catch so reviews still produce market evidence.
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (!key) return holderUnavailable("Alchemy API key not configured");
  const contract = getAddress(contractAddress);
  const rpc = getPublicClient(chainKey);
  try {
    const response = await fetch(getChain(chainKey).httpRpc(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getTokenHolders", params: [{ contractAddress: contract, pageSize: MAX_HOLDERS }] }),
    });
    if (!response.ok) return holderUnavailable(`alchemy_getTokenHolders HTTP ${response.status} (tier-gated on free plans)`);
    const body = await response.json();
    if (body.error) return holderUnavailable(`alchemy_getTokenHolders: ${body.error.message}`);
    const holders = body.result?.holders ?? body.result?.tokenHolders ?? [];
    if (!Array.isArray(holders)) return holderUnavailable("unexpected holder response shape");
    const totalSupplyRaw = await rpc.readContract({ address: contract, abi: ERC20_SUPPLY_ABI, functionName: "totalSupply" });
    const totalSupply = Number(formatUnits(totalSupplyRaw, decimals));
    const normalized = holders.map((h) => {
      const address = (h.address ?? h.ownerAddress ?? h.walletAddress ?? null)?.toLowerCase?.() ?? null;
      const raw = h.balance ?? h.tokenBalance ?? h.amount ?? "0";
      const rawBig = typeof raw === "string" && raw.includes(".") ? BigInt(Math.round(Number(raw) * 10 ** decimals)) : BigInt(raw ?? 0);
      return { address, balance: Number(formatUnits(rawBig, decimals)) };
    }).filter((h) => h.address && Number.isFinite(h.balance));
    const topHolders = normalized.slice(0, MAX_HOLDERS);
    const topHolderPct = totalSupply > 0 ? (topHolders.reduce((sum, h) => sum + h.balance, 0) / totalSupply) * 100 : null;
    return {
      status: body.result?.pageKey ? "partial" : "available",
      source: "alchemy_getTokenHolders",
      holderCount: body.result?.totalCount ?? body.result?.totalHolders ?? null,
      sampledTopHolderCount: topHolders.length,
      topHolderSupplyPct: topHolderPct,
      whaleDefinition: `Top ${Math.min(topHolders.length, MAX_WHALES)} indexed holders`,
      whaleCount: Math.min(topHolders.length, MAX_WHALES),
      whaleActivity: null, // transfer-history scans removed with the Alchemy log pipeline
    };
  } catch (error) {
    return holderUnavailable(error.message);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function collectZoochEvidence({ contractAddress, decimals = 18, chainKey = "ethereum" }) {
  const [venues, ethUsd] = await Promise.all([
    getMarketOverview(contractAddress, chainKey),
    getEthUsdPrice(chainKey).catch(() => null),
  ]);
  const market = {
    source: "dexscreener",
    collectedAt: new Date().toISOString(),
    ethUsd,
    ...summarizeVenues(venues),
    venues: venues.map((v) => ({
      dex: v.dex, labels: v.labels, pairAddress: v.pairAddress, quoteSymbol: v.quoteSymbol,
      priceUsd: v.priceUsd, liquidityUsd: v.liquidityUsd, volume: v.volume, txns: v.txns,
      priceChange: v.priceChange,
    })),
  };
  const holders = await collectHolderEvidence(contractAddress, decimals, chainKey);
  // Per-trade sell-size evidence (Graph Studio subgraphs) was removed with the
  // Zooch planner — this module now supplies market + holder evidence only.
  const trades = { status: "unavailable", reason: "graph evidence removed with zooch" };
  const qualitySignals = [holders, trades].filter((s) => s && "status" in s);
  return {
    collectedAt: new Date().toISOString(),
    contractAddress: contractAddress.toLowerCase(),
    chain: chainKey,
    dataQuality: qualitySignals.every((s) => s.status === "available") ? "complete" : "partial",
    market,
    holders,
    trades,
  };
}
