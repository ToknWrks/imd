/**
 * alpha-engine.mjs — IMD launchpad alpha discovery engine
 *
 * Standalone fork of /accumulate's alpha engine, rebuilt around the IMD
 * Community Coins launchpad on Ethereum mainnet (see CLAUDE.md).
 *
 *   - Discovery + enrichment: the launchpad's public GraphQL indexer
 *     (https://imd-communitycoins-indexer.up.railway.app/graphql) — coins,
 *     trades (timestamp/trader filters), launchpad stats. Third-party hosted:
 *     everything must be cross-verified against the hook before execution
 *     paths trust it. Fallback if it disappears: factory `launch()` events (TODO).
 *   - Curve-native enrichment for free: coins sold %, backing
 *     (virtualImd − initialVirtualImd), creator fees, burns, per-coin flow
 *     with unique-buyer counts.
 *   - Scoring: tokenScore() ported verbatim from /accumulate, plus
 *     curveTokenScore() — weights unique curve buyers over raw ETH volume
 *     (curve volume is ~2%-fee-clipped and tiny early on).
 *   - GoPlus security on chain id 1 (mainnet).
 *   - Field aliases (volume24h, liquidity, change24h) keep the dashboard's
 *     shared row renderer + filters working unchanged.
 *
 * Run inside the dashboard process: `startAlphaEngine()` polls on timers and
 * keeps last-good state in memory + a JSON cache, so restarts are harmless.
 * Read-only — no trading happens here.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "data");
const CACHE_FILE = resolve(DATA_DIR, "alpha-cache.json");

// ── Config (env-overridable) ──────────────────────────────────────────────────
export const IMD_INDEXER_URL = process.env.IMD_INDEXER_URL || "https://imd-communitycoins-indexer.up.railway.app/graphql";
// Reserve IMD token (the curve's dollar) — NOT launched on the platform.
export const IMD_RESERVE = (process.env.IMD_RESERVE_ADDRESS || "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7").toLowerCase();
// Launchpad hook + factory — identity checks / future on-chain verification.
export const LAUNCHPAD_HOOK = (process.env.LAUNCHPAD_HOOK || "0x51768F5dA32BA2008304cC81674da51aCb802888").toLowerCase();
export const LAUNCHPAD_FACTORY = (process.env.LAUNCHPAD_FACTORY || "0x73d1ae084F04f793A5bbd6B623d74400C9Fc3f42").toLowerCase();
const POLL_MS = Number(process.env.ALPHA_POLL_MS || 60_000);
const SECURITY_POLL_MS = Number(process.env.ALPHA_POLL_SECURITY_MS || 120_000);
const TRADE_WINDOW_H = Number(process.env.ALPHA_TRADE_WINDOW_H || 24);
const TRADE_MAX_PAGES = Number(process.env.ALPHA_TRADE_MAX_PAGES || 6);
const SECURITY_TTL_MS = 6 * 3600 * 1000;
const GOPLUS_URL = process.env.GOPLUS_URL || "https://api.gopluslabs.io/api/v1/token_security/1"; // chain id 1 = mainnet (.io is the working host; .com fails TLS)
const COIN_PAGE_SIZE = 500;
const MAX_QUEUE = Number(process.env.ALPHA_MAX_QUEUE || 150);

// ── Helpers ───────────────────────────────────────────────────────────────────
const lower = s => String(s || "").toLowerCase();
const clamp = (n, a = 0, b = 100) => Math.max(a, Math.min(b, n));
const logScore = (v, base) => Math.log10(Math.max(1, v)) / Math.log10(base);
const wei = v => { try { return Number(BigInt(v)) / 1e18; } catch { return 0; } };

async function gql(query, variables = {}, timeoutMs = 15000) {
  const r = await fetch(IMD_INDEXER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`indexer HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors?.length) throw new Error(`indexer: ${j.errors[0].message}`);
  return j.data;
}

// ── Scoring (tokenScore ported verbatim from /accumulate → COPY) ──────────────
export function tokenScore(t) {
  const ageSec = Math.max(1, Number(t.ageSec || 1));
  const buyers = Number(t.uniqueBuyers || 0);
  const buys = Number(t.buys || 0), sells = Number(t.sells || 0);
  const buyPressure = buys + sells ? buys / (buys + sells) : 0.5;
  const quote = Number(t.quoteVolume || 0);
  const fresh = clamp(28 - Math.log10(ageSec) * 7, 3, 28);
  const flow = clamp(buyPressure * 25, 0, 25);
  const smart = clamp(Math.log2(1 + buyers) * 8, 0, 24);
  const vol = clamp(logScore(1 + quote, 1e5) * 17, 0, 17);
  return Math.round(clamp(8 + fresh + flow + smart + vol));
}

// Curve-native score: unique curve buyers + buy pressure dominate; ETH volume
// is ~2%-fee-clipped so it matters less (CLAUDE.md §Alpha).
export function curveTokenScore(t) {
  const buyers = Number(t.uniqueBuyers || 0);
  const buys = Number(t.buys || 0), sells = Number(t.sells || 0);
  const tx = buys + sells;
  const buyPressure = tx ? buys / tx : 0.5;
  const ageSec = Math.max(1, Number(t.ageSec || 1));
  const quote = Number(t.quoteVolume || 0);
  const mcap = Math.max(0, Number(t.marketCap || 0));
  const soldPct = clamp(Number(t.soldPct || 0), 0, 100);
  const flow = clamp(buyPressure * 26, 0, 26);
  const smart = clamp(Math.log2(1 + buyers) * 10, 0, 30);      // buyers > volume
  const vol = clamp(logScore(1 + quote, 1e3) * 12, 0, 12);     // curve vol is small
  const fresh = clamp(20 - Math.log10(ageSec) * 5, 2, 20);
  const progress = soldPct > 0 ? clamp(soldPct / 6, 0, 12) : 0; // traction, capped
  const capSweet = mcap > 0 ? clamp(10 - Math.abs(Math.log10(mcap) - 4.9) * 4, 2, 10) : 4;
  return Math.round(clamp(8 + flow + smart + vol + fresh + progress + capSweet));
}

// ── Curve math (k = virtualImd × virtualCoin, per the launchpad docs) ─────────
export function curvePriceImd(c) {
  const vi = BigInt(c.virtualImd), vc = BigInt(c.virtualCoin);
  if (vc <= 0n) return 0;
  return Number(vi) / Number(vc); // spot price in IMD per coin
}

export function coinsSoldPct(c) {
  const supply = BigInt(c.supply), vc = BigInt(c.virtualCoin);
  if (supply <= 0n) return 0;
  const pct = Number(supply - vc) * 100 / Number(supply);
  return Math.max(0, Math.min(100, pct));
}

export function backingImd(c) {
  return Math.max(0, wei(BigInt(c.virtualImd) - BigInt(c.initialVirtualImd)));
}

// ── GoPlus security (chain id 1 = Ethereum mainnet) ───────────────────────────
class SecurityProvider {
  constructor() { this.cache = new Map(); this.busy = false; }
  normalize(raw) {
    if (!raw) return null;
    const analyzed = Object.values(raw).some(v => v !== "" && v != null);
    return {
      analyzed,
      openSource: raw.is_open_source === "1",
      honeypot: raw.honeypot === "1" || raw.cannot_sell_all === "1",
      buyTax: raw.buy_tax === "" ? null : Number(raw.buy_tax),
      sellTax: raw.sell_tax === "" ? null : Number(raw.sell_tax),
      holders: raw.holder_count ? Number(raw.holder_count) : null,
      mintable: raw.is_mintable === "1",
      checkedAt: new Date().toISOString(),
    };
  }
  async fetchBatch(addresses) {
    const out = {};
    for (let i = 0; i < addresses.length; i += 10) {
      const chunk = addresses.slice(i, i + 10);
      try {
        const r = await fetch(`${GOPLUS_URL}?contract_addresses=${chunk.join(",")}`, { signal: AbortSignal.timeout(12000) });
        if (!r.ok) throw new Error(`goplus HTTP ${r.status}`);
        const j = await r.json();
        for (const [addr, raw] of Object.entries(j.result || {})) out[lower(addr)] = this.normalize(raw);
      } catch (e) {
        // Degrade silently: security stays "unknown" for this round
        console.error(`[alpha-engine] goplus batch failed: ${String(e.message).slice(0, 80)}`);
      }
    }
    return out;
  }
  async sync(topAddresses) {
    if (this.busy) return; this.busy = true;
    try {
      const now = Date.now();
      const need = topAddresses.filter(a => { const c = this.cache.get(lower(a)); return !c || now - new Date(c.checkedAt).getTime() > SECURITY_TTL_MS; });
      if (need.length) {
        const fresh = await this.fetchBatch(need.slice(0, 100));
        for (const [addr, data] of Object.entries(fresh)) this.cache.set(addr, data);
      }
      return Object.fromEntries(this.cache.entries());
    } finally { this.busy = false }
  }
}

// ── Engine ────────────────────────────────────────────────────────────────────
const QUERIES = {
  coins: `
    query($limit: Int!, $offset: Int!) {
      coins(orderBy: "createdAt", orderDirection: "desc", limit: $limit, offset: $offset) {
        items { address poolId symbol name creator supply initialVirtualImd
                virtualImd virtualCoin realImd tradeCount buyCount sellCount
                volumeEth volumeCoin creatorFeesEth burnedImd lastTradeAt createdAt }
        pageInfo { hasNextPage }
      }
    }`,
  trades: `
    query($since: BigInt, $limit: Int!, $offset: Int!) {
      trades(where: { timestamp_gte: $since }, orderBy: "timestamp", orderDirection: "desc",
             limit: $limit, offset: $offset) {
        items { coin { address } trader buy ethAmount timestamp }
        pageInfo { hasNextPage }
      }
    }`,
  stats: `
    {
      statss(limit: 1) {
        items { id coins trades volumeEth creatorFeesEth burnFeesImd imdBurned updatedAt }
      }
    }`,
};

class AlphaEngine {
  constructor() {
    this.data = {
      updatedAt: null,
      status: { indexer: "starting", security: "starting" },
      sources: {},
      security: {},
      platform: null,   // launchpad-wide stats (Board header)
      alpha: [],        // scored queue
    };
    this.security = new SecurityProvider();
    this.timer = null; this.secTimer = null;
    this.syncing = false;
  }

  hydrate() {
    try {
      if (!existsSync(CACHE_FILE)) return;
      const raw = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
      if (raw?.alpha?.length) {
        this.data.alpha = raw.alpha;
        this.data.platform = raw.platform ?? null;
        this.data.updatedAt = raw.updatedAt ?? null;
        this.data.status.indexer = "stale";
        console.log(`[alpha-engine] hydrated ${raw.alpha.length} rows from cache`);
      }
    } catch (e) {
      console.error(`[alpha-engine] hydrate failed: ${e.message}`);
    }
  }

  save() {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const tmp = CACHE_FILE + ".tmp";
      writeFileSync(tmp, JSON.stringify({ alpha: this.data.alpha, platform: this.data.platform, updatedAt: this.data.updatedAt }));
      renameSync(tmp, CACHE_FILE);
    } catch (e) {
      console.error(`[alpha-engine] save failed: ${e.message}`);
    }
  }

  async syncIndexer() {
    if (this.syncing) return; this.syncing = true;
    try {
      // 1. all coins (paged)
      const coins = [];
      let offset = 0;
      for (;;) {
        const d = await gql(QUERIES.coins, { limit: COIN_PAGE_SIZE, offset });
        const page = d.coins.items;
        coins.push(...page);
        if (!d.coins.pageInfo.hasNextPage || !page.length) break;
        offset += COIN_PAGE_SIZE;
      }
      // 2. recent trades (24h window, paged, capped)
      const since = String(Math.floor(Date.now() / 1000) - TRADE_WINDOW_H * 3600);
      const trades = [];
      offset = 0;
      for (;;) {
        const d = await gql(QUERIES.trades, { since, limit: 500, offset });
        const page = d.trades.items;
        trades.push(...page);
        if (!d.trades.pageInfo.hasNextPage || !page.length || offset >= 500 * TRADE_MAX_PAGES) break;
        offset += 500;
      }
      // 3. platform stats (Board header)
      let platform = this.data.platform;
      try {
        const d = await gql(QUERIES.stats);
        const s = d.statss.items[0];
        if (s) platform = {
          coins: s.coins, trades: s.trades,
          volumeEth: wei(s.volumeEth), creatorFeesEth: wei(s.creatorFeesEth),
          burnFeesImd: wei(s.burnFeesImd), imdBurned: wei(s.imdBurned),
          updatedAt: new Date(Number(s.updatedAt) * 1000).toISOString(),
        };
      } catch { /* stats are cosmetic; coins/trades already succeeded */ }

      this.data.coins = coins;
      this.data.trades = trades;
      this.data.platform = platform;
      this.data.status.indexer = "online";
      this.data.sources.indexer = { fresh: true, provider: "imd-indexer", url: IMD_INDEXER_URL, lastSync: new Date().toISOString(), coinCount: coins.length, tradeCount: trades.length };
      this.recompute();
    } catch (e) {
      this.data.status.indexer = "degraded";
      this.data.sources.indexer = { ...(this.data.sources.indexer || {}), fresh: false, error: String(e.message || e), lastAttempt: new Date().toISOString() };
      console.error(`[alpha-engine] indexer sync failed: ${e.message}`);
    } finally { this.syncing = false }
  }

  recompute() {
    const coins = this.data.coins || [], trades = this.data.trades || [];
    const now = Date.now();
    const byCoin = new Map();
    for (const t of trades) {
      const a = lower(t.coin?.address);
      if (!byCoin.has(a)) byCoin.set(a, { buys: 0, sells: 0, buyers: new Set(), volEth: 0, vol1h: 0 });
      const d = byCoin.get(a);
      const eth = wei(t.ethAmount);
      if (t.buy) { d.buys++; d.buyers.add(lower(t.trader)); } else d.sells++;
      d.volEth += eth;
      if (now / 1000 - Number(t.timestamp) <= 3600) d.vol1h += eth;
    }
    const imdUsd = Number(this.data.imdUsd || 0); // set externally by the dashboard (ETH/IMD pool price)
    const alpha = [];
    for (const c of coins) {
      const a = lower(c.address);
      if (a === lower(IMD_RESERVE)) continue;    // reserve IMD is not a curve coin
      const flow = byCoin.get(a) || { buys: 0, sells: 0, buyers: new Set(), volEth: 0, vol1h: 0 };
      const priceImd = curvePriceImd(c);
      const soldPct = coinsSoldPct(c);
      const ageSec = Math.max(1, (now - Number(c.createdAt) * 1000) / 1000);
      const vol24h = wei(c.volumeEth);
      const mcap = imdUsd > 0 ? priceImd * imdUsd * 1e9 : 0;  // 1B supply
      const base = {
        token: c.address,
        address: c.address,
        poolId: c.poolId,
        symbol: c.symbol,
        name: c.name,
        creator: c.creator,
        protocol: "IMD CURVE",
        source: "IMD-INDEXER",
        kind: "launch",
        real: true,
        soldPct: Number(soldPct.toFixed(2)),
        priceImd,
        backingImd: backingImd(c),
        hookHeldPct: Number((100 - soldPct).toFixed(2)),
        tradeCount: c.tradeCount,
        buys: flow.buys, sells: flow.sells,
        uniqueBuyers: flow.buyers.size,
        quoteVolume: flow.volEth,           // ETH, 24h window
        volume1hEth: flow.vol1h,
        volume24hEth: vol24h,
        creatorFeesEth: wei(c.creatorFeesEth),
        burnedImd: wei(c.burnedImd),
        marketCap: mcap,
        createdAt: new Date(Number(c.createdAt) * 1000).toISOString(),
        lastTradeAt: c.lastTradeAt ? new Date(Number(c.lastTradeAt) * 1000).toISOString() : null,
        ageSec,
        url: `https://communitycoins.imd.fun/token/${c.address}`,
        // provenance: EVERY coin here is a permissionless launch — unverified
        // until the Sniper's empirical sell probe passes (QUORUM lesson).
        verified: false,
        provenance: "unverified — permissionless launch, not sell-probed",
        security: this.data.security?.[a] ?? null,
        hasSecondaryPool: false,            // Dexscreener secondary-pool detection TODO
        // ── dashboard renderer/filter compatibility aliases ──
        volume24h: vol24h,                  // ETH units; filters read volume24h
        liquidity: 0,                       // curves have no LP — backing is the honesty metric
        change24h: null,                    // indexer has no OHLC window yet
        graduated: false,                   // no "graduation" concept on this launchpad
      };
      base.score = Math.max(tokenScore(base), curveTokenScore(base));
      base.scorer = curveTokenScore(base) >= tokenScore(base) ? "curve" : "generic";
      alpha.push(base);
    }
    alpha.sort((x, y) => Number(y.score || 0) - Number(x.score || 0) || Number(y.quoteVolume || 0) - Number(x.quoteVolume || 0));
    this.data.alpha = alpha.slice(0, MAX_QUEUE);
    this.data.updatedAt = new Date().toISOString();
  }

  async syncSecurity() {
    try {
      const addrs = (this.data.alpha || []).slice(0, 100).map(t => t.address).filter(Boolean);
      const map = await this.security.sync(addrs);
      if (map) { this.data.security = map; this.recompute(); }
      this.data.sources.security = { fresh: true, provider: "goplus", lastSync: new Date().toISOString(), count: Object.keys(map || {}).length };
    } catch (e) {
      this.data.sources.security = { ...(this.data.sources.security || {}), fresh: false, error: String(e.message || e), lastAttempt: new Date().toISOString() };
    }
  }

  lastError() {
    const i = this.data.sources.indexer?.error, s = this.data.sources.security?.error;
    const parts = [];
    if (i) parts.push(`indexer: ${i}`);
    if (s) parts.push(`goplus: ${s}`);
    return parts.join(" · ") || null;
  }

  snapshot() {
    return {
      items: this.data.alpha,
      platform: this.data.platform,
      status: this.data.status,
      sources: this.data.sources,
      updatedAt: this.data.updatedAt,
      error: this.lastError(),
    };
  }

  async start() {
    this.hydrate();
    this.recompute();
    this.syncIndexer();
    setTimeout(() => this.syncSecurity(), 5000);
    this.timer = setInterval(() => this.syncIndexer(), POLL_MS); this.timer.unref();
    this.secTimer = setInterval(() => this.syncSecurity(), SECURITY_POLL_MS); this.secTimer.unref();
    const saveTimer = setInterval(() => this.save(), 60_000); saveTimer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.secTimer) clearInterval(this.secTimer);
  }
}

export const alphaEngine = new AlphaEngine();
export async function startAlphaEngine() { await alphaEngine.start(); }
export function getAlphaQueue() { return alphaEngine.snapshot(); }
