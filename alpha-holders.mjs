/**
 * alpha-holders.mjs — curve holder distribution for the Alpha token modal
 *
 * The IMD Community Coins launchpad has no LP and no transfers — the ONLY way
 * a coin's balance changes is a curve trade, so net position per wallet
 * (Σ buys − Σ sells, from the launchpad indexer's full trade history) IS the
 * on-chain balance. That gives us a complete holder distribution with no
 * holder-indexer subscription (alchemy_getTokenHolders is tier-gated on free
 * keys — see zooch-data.mjs).
 *
 * Provenance caveats surfaced in the UI:
 *  - Derived from trades reported by the indexer (third-party hosted) —
 *    cross-verify anything execution-critical against the hook (CLAUDE.md rule).
 *  - Supply denominator = Σ of net-positive balances, matching the indexer's
 *    own supply field on the coins we tested (BALLOON: 1e9 = 1e27 raw / 1e18).
 *  - If a coin EVER gains off-curve transfers (graduation), this view goes
 *    stale by definition — `complete: false` is returned when tradeCount
 *    pagination was capped.
 */
import { IMD_INDEXER_URL } from "./alpha-engine.mjs";

const CACHE_TTL_MS = Number(process.env.ALPHA_HOLDERS_TTL_MS || 5 * 60 * 1000);
const MAX_TRADES = Number(process.env.ALPHA_HOLDERS_MAX_TRADES || 20000);
const TOP_N = 12;              // slices in the donut before "others"
const PAGE = 500;

const cache = new Map();       // coinAddress -> { at, data }

async function gql(query, variables) {
  const r = await fetch(IMD_INDEXER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`indexer HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
}

const COIN_Q = `
  query($addr: String!) {
    coin(address: $addr) {
      address symbol name creator supply
      tradeCount buyCount sellCount volumeEth
      createdAt lastTradeAt
    }
  }`;

const TRADES_Q = `
  query($coin: String!, $limit: Int!, $offset: Int!) {
    trades(where: { coin: $coin }, orderBy: "timestamp", orderDirection: "asc",
           limit: $limit, offset: $offset) {
      items { trader buy coinAmount imdAmount timestamp }
      pageInfo { hasNextPage }
      totalCount
    }
  }`;
// (No timestamp filter: the indexer treats timestamp_gte: null as a literal
// match against epoch 0 and returns zero rows — verified live 2026-09-16.)

const wei = (v) => Number(BigInt(v ?? 0)) / 1e18;

/**
 * Full holder distribution for a curve coin.
 * @param {string} coinAddress
 * @param {object} [opts] { userAddress: string|null } — wallet to highlight
 */
export async function getCurveHolderDistribution(coinAddress, opts = {}) {
  const coin = String(coinAddress || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(coin)) throw new Error("invalid coin address");
  const user = opts.userAddress ? String(opts.userAddress).toLowerCase() : null;

  const hit = cache.get(coin);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return annotate(hit.data, user);   // user overlay is cheap — recompute per request
  }

  const cd = await gql(COIN_Q, { addr: coin });
  const c = cd?.coin;
  if (!c) throw new Error("coin not found on the indexer");

  // History cap: for very old coins with huge trade counts, only the most
  // recent MAX_TRADES trades are fetched (pagination skips ahead). Positions
  // are then INCOMPLETE — flagged via `complete: false`.
  const totalTrades = Number(c.tradeCount || 0);
  const skip = Math.max(0, totalTrades - MAX_TRADES);
  let offset = skip;
  const net = new Map();        // trader -> net coin (raw bigint)
  const cost = new Map();       // trader -> cumulative IMD spent on buys (raw bigint)
  let fetched = 0;
  for (;;) {
    const d = await gql(TRADES_Q, { coin, limit: PAGE, offset });
    const items = d.trades?.items ?? [];
    for (const t of items) {
      const a = String(t.trader || "").toLowerCase();
      if (!a) continue;
      if (!net.has(a)) { net.set(a, 0n); cost.set(a, 0n); }
      const amt = BigInt(t.coinAmount ?? 0);
      net.set(a, net.get(a) + (t.buy ? amt : -amt));
      if (t.buy) cost.set(a, cost.get(a) + BigInt(t.imdAmount ?? 0));
    }
    fetched += items.length;
    if (!d.trades.pageInfo?.hasNextPage || !items.length) break;
    offset += PAGE;
    if (fetched >= MAX_TRADES) break;
  }

  const holders = [...net.entries()]
    .filter(([, v]) => v > 0n)
    .map(([address, raw]) => ({ address, raw }))
    .sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0));
  const supplyRaw = holders.reduce((s, h) => s + h.raw, 0n);

  const data = {
    coin: {
      address: c.address, symbol: c.symbol, name: c.name,
      creator: String(c.creator || "").toLowerCase(),
      supply: wei(c.supply), tradeCount: totalTrades,
      buyCount: Number(c.buyCount || 0), sellCount: Number(c.sellCount || 0),
      volumeImd: wei(c.volumeEth), createdAt: c.createdAt ? Number(c.createdAt) * 1000 : null,
      lastTradeAt: c.lastTradeAt ? Number(c.lastTradeAt) * 1000 : null,
    },
    complete: skip === 0 && fetched < MAX_TRADES,
    tradesAnalyzed: fetched,
    tradesSkipped: skip,
    walletsTraded: net.size,
    holders: holders.map((h) => ({
      address: h.address,
      pct: supplyRaw > 0n ? Number((h.raw * 10000n) / supplyRaw) / 100 : 0,
      amount: Number(h.raw) / 1e18,
      imdSpent: wei(cost.get(h.address) ?? 0n),
    })),
  };
  cache.set(coin, { at: Date.now(), data });
  return annotate(data, user);
}

/** Per-request overlay: user's own position + creator flag (not cached). */
function annotate(data, user) {
  const creator = data.coin.creator;
  const out = {
    ...data,
    holders: data.holders.map((h) => ({
      ...h,
      isCreator: h.address === creator,
    })),
    user: null,
  };
  if (user) {
    const me = out.holders.find((h) => h.address === user);
    if (me) {
      const avg = me.imdSpent > 0 ? me.imdSpent / me.amount : null; // IMD per coin, buy-side only
      out.user = {
        address: user, pct: me.pct, amount: me.amount,
        rank: out.holders.findIndex((h) => h.address === user) + 1,
        avgEntryImd: avg, isCreator: me.address === creator,
      };
    } else {
      out.user = { address: user, pct: 0, amount: 0, rank: null, avgEntryImd: null, isCreator: false };
    }
  }
  return out;
}
