/**
 * alpha-engine.mjs — self-contained alpha discovery engine (ported from COPY)
 *
 * Replaces the external COPY service (ToknWrks/copy) for the Alpha tab:
 *   - DexScreener discovery: Robinhood-chain token profiles, boosts, market pairs
 *   - On-chain PONS launch/trade scanning (V2 bonding curves + Classic pools)
 *   - Heuristic scoring (tokenScore / marketTokenScore, ported verbatim)
 *   - Alpha list = deduped launches + market tokens, scored and sorted
 *
 * FOMO wallet-leaderboard/trending feeds are intentionally NOT ported (needs a
 * bearer key; the queue works without it). No trading happens here — read-only.
 *
 * Run inside the dashboard process: `startAlphaEngine()` polls on timers and
 * keeps the last-good state in memory + a JSON cache file, so dashboard
 * restarts are harmless and brief downtime just means stale data.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { keccak256, toHex } from "viem";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = resolve(__dirname, "data", "alpha-cache.json");

// ── Config (env-overridable, same defaults as COPY) ───────────────────────────
const RH_RPC_URL = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
// 30s was too aggressive once the LONG scan joined: the public Robinhood RPC
// 429s under backfill load (verified 2026-09-11) and then throttles EVERYTHING.
// 2min ticks with 1 segment/tick keep the poll alive; convergence is slower.
const CHAIN_POLL_MS = Number(process.env.ALPHA_POLL_CHAIN_MS || 120000);
const DEX_POLL_MS = Number(process.env.ALPHA_POLL_DEX_MS || 15000);
const INITIAL_LOOKBACK = BigInt(process.env.ALPHA_INITIAL_LOOKBACK || 24000);
// Trade scans only matter for freshness scoring on young launches — sweeping
// all curves/pools every tick was the dominant RPC cost. 24h window: older
// launches' buy/sell counters barely move.
const TRADE_SCAN_MAX_AGE_MS = Number(process.env.ALPHA_TRADE_SCAN_MAX_AGE_MS || 24 * 3600 * 1000);
const MAX_SEGMENTS_PER_TICK = Number(process.env.ALPHA_MAX_SEGMENTS || 1);

// ── Scoring (ported verbatim from COPY scoring.mjs) ───────────────────────────
const clamp = (n, a = 0, b = 100) => Math.max(a, Math.min(b, n));
const logScore = (v, base) => Math.log10(Math.max(1, v)) / Math.log10(base);

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

export function marketTokenScore(t) {
  const buys = Number(t.buys || 0), sells = Number(t.sells || 0), tx = buys + sells;
  const pressure = tx ? buys / tx : .5;
  const volume = Math.max(0, Number(t.volume24h || 0));
  const liq = Math.max(0, Number(t.liquidity || 0));
  const mcap = Math.max(0, Number(t.marketCap || 0));
  const change = Number(t.change24h || 0);
  const flow = clamp(pressure * 26, 0, 26);
  const activity = clamp(Math.log10(1 + tx) * 8, 0, 16);
  const volumePart = clamp(Math.log10(1 + volume) / 6 * 18, 0, 18);
  const liqPart = clamp(Math.log10(1 + liq) / 6 * 16, 0, 16);
  const momentum = clamp((change + 30) / 6, 0, 12);
  const capSweet = mcap > 0 ? clamp(12 - Math.abs(Math.log10(mcap) - 5.3) * 5, 2, 12) : 4;
  return Math.round(clamp(8 + flow + activity + volumePart + liqPart + momentum + capSweet));
}

// ── Robinhood chain provider (PONS launches + trades; ported from COPY) ───────
const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const CLASSIC_FACTORIES = ["0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB", "0x0c37a24F5D23A486FA692d1500881d698B1F77a4"];
const TOPIC_CLASSIC_LAUNCH = "0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a";
const TOPIC_CLASSIC_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const TOPIC_LAUNCH = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
const TOPIC_BUY = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455";
const TOPIC_SELL = "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df";
// StonkBrokers launchpad executor: emits one event per routed order with
//   data w0 = V3 pool, w1 = quote token, w2 = TOKEN address
// (verified on LAURA's creation tx 0x640fec97…). Any token with orders through
// this executor is a launchpad listing/graduate.
const STONK_EXECUTOR = "0x8f10b468b06c6fd214b65f87778827f7d113f996";
const TOPIC_STONK_ORDER = "0xa6fee24309b1d83d9ec7b9e4dbb73c6f882746efbfb26db7b7d9e9f2fb6dc95a";
const ZERO = "0x0000000000000000000000000000000000000000";
// System tokens the executor also swaps — never launchpad graduates.
const STONK_SYSTEM = new Set([
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73", // WETH
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG
  ZERO,
]);
const unhex = h => BigInt(h || "0x0");
const signed = h => { const v = unhex(h), M = 1n << 256n, H = 1n << 255n; return v >= H ? v - M : v };
const hex = n => "0x" + BigInt(n).toString(16);
const word = (data, i) => "0x" + String(data || "0x").slice(2 + i * 64, 2 + (i + 1) * 64);
const topicAddr = t => "0x" + String(t).slice(-40);
const dataAddr = (d, i) => "0x" + word(d, i).slice(-40);
const lower = a => String(a || "").toLowerCase();
const abs = x => x < 0n ? -x : x;
const fmt18Big = n => { n = abs(BigInt(n)); const whole = n / 10n ** 18n, frac = (n % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, ""); return frac ? `${whole}.${frac}` : `${whole}` };
const fmt18 = v => fmt18Big(unhex(v));
function decodeString(hexdata) {
  try { let h = String(hexdata || "0x").slice(2); if (!h) return ""; const offset = Number(BigInt("0x" + h.slice(0, 64))); const len = Number(BigInt("0x" + h.slice(offset * 2, offset * 2 + 64))); const body = h.slice(offset * 2 + 64, offset * 2 + 64 + len * 2); return Buffer.from(body, "hex").toString("utf8").replace(/\0/g, "") } catch { return "" }
}

export class RobinhoodProvider {
  constructor({ rpcUrl, initialLookback = 24000n }) {
    this.url = rpcUrl; this.initialLookback = BigInt(initialLookback);
    this.lastBlock = null; this.curves = new Map(); this.classic = new Map(); this.classicPools = new Map();
    this.longPools = new Map(); this.longStocks = new Set();
    this.stonk = new Map();
    this.tokens = new Map(); this.events = []; this.head = 0n; this.id = 1; this.blockTimes = new Map();
  }
  async rpc(method, params = []) {
    const r = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method, params }), signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || "rpc error");
    return d.result;
  }
  async init(seed = {}) {
    for (const l of seed.launches || []) if (l?.token) {
      if (l.protocol === "PONS CLASSIC" && l.pool) { this.classic.set(lower(l.token), l); this.classicPools.set(lower(l.pool), l) }
      else if (l.curve) this.curves.set(lower(l.curve), l);
      else if (l.protocol === "LONG" && l.poolId) this.longPools.set(lower(l.token), l);
      else if (l.protocol === "STONK") this.stonk.set(lower(l.token), l);
      this.tokens.set(lower(l.token), l);
    }
    if (seed.lastChainBlock) this.lastBlock = BigInt(seed.lastChainBlock);
    return this.poll(true);
  }
  async ethCall(to, data) { return this.rpc("eth_call", [{ to, data }, "latest"]) }
  async tokenMeta(token) {
    const prev = this.tokens.get(lower(token));
    if (prev?.symbol && prev?.name) return prev;
    const [sr, nr, dr] = await Promise.allSettled([this.ethCall(token, "0x95d89b41"), this.ethCall(token, "0x06fdde03"), this.ethCall(token, "0x313ce567")]);
    return { symbol: sr.status === "fulfilled" ? decodeString(sr.value) || "TOKEN" : "TOKEN", name: nr.status === "fulfilled" ? decodeString(nr.value) || "Robinhood token" : "Robinhood token", decimals: dr.status === "fulfilled" ? Number(unhex(dr.value)) : 18 };
  }
  async blockTime(blockNumber) {
    const k = String(blockNumber);
    if (this.blockTimes.has(k)) return this.blockTimes.get(k);
    let iso = new Date().toISOString();
    try { const b = await this.rpc("eth_getBlockByNumber", [blockNumber, false]); if (b?.timestamp) iso = new Date(Number(unhex(b.timestamp)) * 1000).toISOString() } catch {}
    this.blockTimes.set(k, iso);
    if (this.blockTimes.size > 1200) this.blockTimes.delete(this.blockTimes.keys().next().value);
    return iso;
  }
  async logs(address, topics, from, to) { return this.rpc("eth_getLogs", [{ address, topics, fromBlock: hex(from), toBlock: hex(to) }]) }
  // ── LONG (long.xyz) launch discovery ────────────────────────────────────────
  // LONG tokens live in hooked V4 pools {token, stockToken}, hook 0x4e34…a544
  // (verified in long-platform.mjs). There is no factory Launch event — a new
  // LONG token announces itself via a PoolManager Initialize whose hooks topic
  // is the LONG hook. The token is the NON-stock side; stocks are identified by
  // appearing as counterparty across many pools (a stock gets one pool per
  // launched token). No tokenMeta calls at scan time — symbols arrive via the
  // DexScreener merge in recompute(). Zero-curve-trade tokens: buys/sells/vol
  // come from DexScreener (recompute handles protocol === "LONG").
  static LONG_HOOK = "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544";
  async scanLongLaunches(from, to) {
    // hooks is NOT indexed in Initialize (only id/currency0/currency1 are), so
    // the filter is client-side on the data's hooks word. CRITICAL: raw-JSON-RPC
    // eth_getLogs on the public Robinhood RPC silently returns EMPTY for
    // PoolManager log queries (verified: 0 logs at every range size while the
    // same query via viem returns 522 in 100 blocks) — so this MUST go through
    // viem, and the public RPC caps getLogs ~1,200 blocks per call.
    if (!this._logsClient) {
      const { createPublicClient, http } = await import("viem");
      this._logsClient = createPublicClient({ transport: http(this.url, { retryCount: 1 }) });
    }
    const TOPIC_INIT = keccak256(toHex("Initialize(address,address,address,uint24,int24,address,bytes32)"));
    const HOOK_LC = RobinhoodProvider.LONG_HOOK.toLowerCase();
    const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
    let logs = [];
    try { logs = await this._logsClient.getLogs({ address: PM, topics: [TOPIC_INIT], fromBlock: from, toBlock: to }) } catch { return }
    for (const l of logs) {
      const words = String(l.data).slice(2).match(/.{64}/g) || [];
      const hook = ("0x" + (words[2]?.slice(24) || "")).toLowerCase();
      if (hook !== HOOK_LC) continue;
      const id = l.topics[1], c0 = topicAddr(l.topics[2]), c1 = topicAddr(l.topics[3]);
      const fee = Number(unhex(word(l.data, 0))), tickSpacing = Number(signed(word(l.data, 1)));
      if (this.longPools.has(lower(id))) continue;
      this.longPools.set(lower(id), { id, c0, c1, fee, tickSpacing, blockNumber: String(unhex(l.blockNumber)), createdAt: null });
    }
    this.classifyLongs();
  }
  async scanStonkLaunches(from, to) {
    // StonkBrokers launchpad: its executor emits one event per routed order
    // with data w0 = V3 pool, w1 = quote token, w2 = TOKEN address (verified on
    // LAURA's creation tx 0x640fec97…). A token seen here is a launchpad
    // listing — registered as a launch so the standard graduation
    // cross-reference (DexScreener pair presence) + scoring pipeline apply.
    let logs = []; try { logs = await this.logs([STONK_EXECUTOR], [[TOPIC_STONK_ORDER]], from, to) } catch { return }
    for (const l of logs) {
      const token = dataAddr(l.data, 2);
      if (!valid(token) || STONK_SYSTEM.has(lower(token))) continue;
      const k = lower(token);
      if (this.tokens.get(k)?.protocol === "STONK") continue; // already registered
      const meta = await this.tokenMeta(token);
      const createdAt = await this.blockTime(l.blockNumber);
      const item = { token, protocol: "STONK", executor: lower(STONK_EXECUTOR), blockNumber: String(unhex(l.blockNumber)), createdAt, symbol: meta.symbol, name: meta.name, decimals: meta.decimals };
      this.tokens.set(k, item);
      this.stonk.set(k, item);
    }
  }
  /** Classify LONG pools: counterparty seen with >=3 distinct tokens = stock. */
  classifyLongs() {
    const pairCounts = new Map(); // currency -> Set(token partners)
    for (const p of this.longPools.values()) {
      for (const [a, b] of [[p.c0, p.c1], [p.c1, p.c0]]) {
        if (!pairCounts.has(lower(a))) pairCounts.set(lower(a), new Set());
        pairCounts.get(lower(a)).add(lower(b));
      }
    }
    for (const [cur, partners] of pairCounts) {
      if (partners.size >= 3 && !this.longStocks.has(lower(cur))) this.longStocks.add(lower(cur));
    }
    // Promote classified pools into launches: token = the non-stock side.
    for (const [id, p] of this.longPools) {
      if (p.token) continue;
      const c0s = this.longStocks.has(lower(p.c0)), c1s = this.longStocks.has(lower(p.c1));
      if (c0s === c1s) continue; // both or neither known — wait for more data
      const token = c0s ? p.c1 : p.c0, stock = c0s ? p.c0 : p.c1;
      this.tokens.set(lower(token), this.tokens.get(lower(token)) || {});
      this.longPools.set(id, { ...p, token, stock, protocol: "LONG" });
    }
  }
  async poll(initial = false) {
    this.head = unhex(await this.rpc("eth_blockNumber"));
    let from = this.lastBlock != null ? this.lastBlock + 1n : this.head - (initial ? this.initialLookback : 1200n);
    if (from < 0n) from = 0n;
    if (from > this.head) return this.snapshot();
    // Cap the work per tick so a large backfill can't monopolize the poll loop
    // or trip the public RPC's rate limiter (HTTP 429). The next tick resumes
    // from where this one stopped — convergence is incremental.
    let processed = 0, lastProcessed = this.lastBlock ?? from;
    for (let s = from; s <= this.head && processed < MAX_SEGMENTS_PER_TICK; s += 1200n) {
      const e = s + 1199n > this.head ? this.head : s + 1199n;
      await this.scanLaunches(s, e);
      await this.scanClassicLaunches(s, e);
      await this.scanTrades(s, e);
      await this.scanClassicTrades(s, e);
      await this.scanLongLaunches(s, e);
      await this.scanStonkLaunches(s, e);
      lastProcessed = e; processed++;
    }
    this.lastBlock = lastProcessed;
    return this.snapshot();
  }
  async scanLaunches(from, to) {
    let logs = []; try { logs = await this.logs(FACTORY, [TOPIC_LAUNCH], from, to) } catch { return }
    for (const l of logs) {
      if (!l.topics?.[1] || !l.topics?.[2]) continue;
      const token = topicAddr(l.topics[1]), curve = topicAddr(l.topics[2]), deployer = topicAddr(l.topics[3]), pairToken = dataAddr(l.data, 0);
      const meta = await this.tokenMeta(token);
      const createdAt = await this.blockTime(l.blockNumber);
      const item = { token, curve, deployer, pairToken, protocol: "PONS V2", launchConfigId: Number(unhex(word(l.data, 1))), graduationThreshold: String(unhex(word(l.data, 2))), blockNumber: String(unhex(l.blockNumber)), createdAt, symbol: meta.symbol, name: meta.name, decimals: meta.decimals };
      this.curves.set(lower(curve), item); this.tokens.set(lower(token), item);
    }
  }
  async scanClassicLaunches(from, to) {
    for (const factory of CLASSIC_FACTORIES) {
      let logs = []; try { logs = await this.logs(factory, [TOPIC_CLASSIC_LAUNCH], from, to) } catch { continue }
      for (const l of logs) {
        if (!l.topics?.[1]) continue;
        const token = topicAddr(l.topics[1]), deployer = topicAddr(l.topics[2]), pairToken = dataAddr(l.data, 0), pool = dataAddr(l.data, 1);
        const meta = await this.tokenMeta(token);
        const createdAt = await this.blockTime(l.blockNumber);
        const item = { token, pool, curve: pool, deployer, pairToken, blockNumber: String(unhex(l.blockNumber)), createdAt, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, protocol: "PONS CLASSIC", dexId: Number(unhex(word(l.data, 2))), launchConfigId: Number(unhex(word(l.data, 3))) };
        this.classic.set(lower(token), item); this.classicPools.set(lower(pool), item); this.tokens.set(lower(token), item);
      }
    }
  }
  async scanTrades(from, to) {
    // Freshness scoring only needs trade counters for young launches; sweeping
    // all 600 curves every tick was the dominant RPC cost of each poll.
    const cutoff = Date.now() - TRADE_SCAN_MAX_AGE_MS;
    const curves = [...this.curves.values()].filter(x => new Date(x.createdAt).getTime() >= cutoff).map(x => x.curve);
    for (let i = 0; i < curves.length; i += 70) {
      const batch = curves.slice(i, i + 70);
      let logs = []; try { logs = await this.logs(batch, [[TOPIC_BUY, TOPIC_SELL]], from, to) } catch { continue }
      for (const l of logs) {
        const launch = this.curves.get(lower(l.address));
        if (!launch) continue;
        const isBuy = lower(l.topics[0]) === TOPIC_BUY;
        const id = `${l.transactionHash}:${l.logIndex}`;
        if (this.events.some(x => x.id === id)) continue;
        const e = { id, txHash: l.transactionHash, blockNumber: String(unhex(l.blockNumber)), side: isBuy ? "BUY" : "SELL", wallet: topicAddr(l.topics[1]), recipient: topicAddr(l.topics[2]), token: launch.token, curve: launch.curve, symbol: launch.symbol, name: launch.name, quoteAmount: fmt18(isBuy ? word(l.data, 0) : word(l.data, 1)), quoteSymbol: lower(launch.pairToken) === ZERO ? "ETH" : "QUOTE", fee: String(unhex(word(l.data, 2))), tax: String(unhex(word(l.data, 3))), createdAt: await this.blockTime(l.blockNumber), source: "PONS V2" };
        this.events.unshift(e);
      }
    }
    this.events = this.events.slice(0, 800);
  }
  async scanClassicTrades(from, to) {
    const cutoff = Date.now() - TRADE_SCAN_MAX_AGE_MS;
    const pools = [...this.classicPools.values()].filter(x => new Date(x.createdAt).getTime() >= cutoff).map(x => x.pool);
    for (let i = 0; i < pools.length; i += 70) {
      const batch = pools.slice(i, i + 70);
      let logs = []; try { logs = await this.logs(batch, [TOPIC_CLASSIC_SWAP], from, to) } catch { continue }
      for (const l of logs) {
        const launch = this.classicPools.get(lower(l.address));
        if (!launch) continue;
        const id = `${l.transactionHash}:${l.logIndex}`;
        if (this.events.some(x => x.id === id)) continue;
        const amount0 = signed(word(l.data, 0)), amount1 = signed(word(l.data, 1));
        const tokenIs0 = BigInt(lower(launch.token)) < BigInt(lower(launch.pairToken));
        const tokenAmount = tokenIs0 ? amount0 : amount1, quoteAmount = tokenIs0 ? amount1 : amount0;
        const isBuy = tokenAmount < 0n;
        const sender = l.topics?.[1] ? topicAddr(l.topics[1]) : null, recipient = l.topics?.[2] ? topicAddr(l.topics[2]) : null;
        this.events.unshift({ id, txHash: l.transactionHash, blockNumber: String(unhex(l.blockNumber)), side: isBuy ? "BUY" : "SELL", wallet: recipient || sender, recipient, sender, token: launch.token, curve: launch.pool, symbol: launch.symbol, name: launch.name, quoteAmount: fmt18Big(quoteAmount), quoteSymbol: "ETH", fee: null, tax: null, createdAt: await this.blockTime(l.blockNumber), source: "PONS CLASSIC" });
      }
    }
    this.events = this.events.slice(0, 800);
  }
  snapshot() {
    // LONG pools classified to a token become launch entries (buys/sells come
    // from DexScreener in recompute; createdAt resolved from the init block).
    const longLaunches = [...this.longPools.values()].filter(p => p.token).map(p => ({
      token: p.token, stock: p.stock, poolId: p.id, fee: p.fee, tickSpacing: p.tickSpacing,
      protocol: "LONG", blockNumber: p.blockNumber,
      createdAt: p.createdAt || new Date().toISOString(),
      symbol: this.tokens.get(lower(p.token))?.symbol || null,
    }));
    const stonkLaunches = [...this.stonk.values()].map(p => ({
      token: p.token, protocol: "STONK", executor: p.executor,
      blockNumber: p.blockNumber,
      createdAt: p.createdAt || new Date().toISOString(),
      symbol: this.tokens.get(lower(p.token))?.symbol || p.symbol || null,
      name: this.tokens.get(lower(p.token))?.name || p.name || null,
      decimals: this.tokens.get(lower(p.token))?.decimals ?? p.decimals ?? 18,
    }));
    const launches = [...this.classic.values(), ...this.curves.values(), ...longLaunches, ...stonkLaunches]
      .sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber)).slice(-900);
    return { head: String(this.head), lastChainBlock: String(this.lastBlock || 0n), launches, trades: this.events.slice(0, 600), factory: FACTORY, classicFactories: CLASSIC_FACTORIES, stonkExecutor: lower(STONK_EXECUTOR) };
  }
}

// ── DexScreener provider (ported from COPY) ───────────────────────────────────
const PROFILE_URL = "https://api.dexscreener.com/token-profiles/latest/v1";
const BOOST_URL = "https://api.dexscreener.com/token-boosts/latest/v1";
const TOKENS_URL = "https://api.dexscreener.com/tokens/v1/robinhood/";
const RH = "robinhood";
const valid = a => /^0x[a-fA-F0-9]{40}$/.test(String(a || ""));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null };
const KNOWN = [
  { address: "0x020bfc650a365f8bb26819deaabf3e21291018b4", symbol: "CASHCAT", name: "Cash Cat", website: "https://cashcattoken.cc/", url: "https://dexscreener.com/robinhood/0x020bfc650a365f8bb26819deaabf3e21291018b4" },
  { address: "0x39dBED3a2bd333467115dE45665cC57F813C4571", symbol: "PONS", name: "Pons", website: "https://pons.family/launchpad/0x39dBED3a2bd333467115dE45665cC57F813C4571", url: "https://dexscreener.com/robinhood/0x39dBED3a2bd333467115dE45665cC57F813C4571" },
  { address: "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18", symbol: "AI", name: "Artificial Inu", website: "https://artificialinu.com/", url: "https://dexscreener.com/robinhood/0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18" },
  { address: "0x13ca23fc7c96212c411e95e506567cce9d748d3f", symbol: "KOL", name: "Kol Capital", website: "https://kol.capital/", url: "https://dexscreener.com/robinhood/0x13ca23fc7c96212c411e95e506567cce9d748d3f" },
  { address: "0x32821d4275e88a255782a05439c989cf4a5ba87c", symbol: "BURNIE", name: "Burnie", website: "https://www.burnieonrh.com/", url: "https://dexscreener.com/robinhood/0x32821d4275e88a255782a05439c989cf4a5ba87c" },
  { address: "0x993100d2B2ec49C36568A772b69691963Cfa68d5", symbol: "DUST", name: "Dust", website: "https://dustdot.fun", url: "https://dexscreener.com/robinhood/0x993100d2B2ec49C36568A772b69691963Cfa68d5" },
  { address: "0x7E797Ba9D48e6c1a68ba756dAfdE2602C3a74A3A", symbol: "PULSE", name: "PonsPulse", website: "https://ponspulse.top", url: "https://dexscreener.com/robinhood/0x7E797Ba9D48e6c1a68ba756dAfdE2602C3a74A3A" }
];
async function getJson(url) { const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "Accumulate/1.0 (+read-only market indexer)" }, signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error(`dexscreener ${r.status}`); return r.json() }
const profileWebsite = p => p?.links?.find?.(x => String(x?.label || "").toLowerCase() === "website")?.url || null;
const pairWebsite = p => p?.info?.websites?.find?.(x => x?.url)?.url || null;
function normalizePair(pair, target, profile, boost) {
  const tokenAddress = valid(target) ? target : (pair?.baseToken?.address || "");
  const base = lower(pair?.baseToken?.address) === lower(tokenAddress) ? pair.baseToken : pair?.baseToken || {};
  const h24 = pair?.txns?.h24 || {};
  const created = num(pair?.pairCreatedAt);
  return {
    address: tokenAddress || base.address || null,
    token: tokenAddress || base.address || null,
    symbol: base.symbol || profile?.symbol || "TOKEN", name: base.name || profile?.name || "Robinhood token",
    image: pair?.info?.imageUrl || profile?.icon || profile?.openGraph || null,
    price: num(pair?.priceUsd), marketCap: num(pair?.marketCap ?? pair?.fdv), liquidity: num(pair?.liquidity?.usd), volume24h: num(pair?.volume?.h24), change24h: num(pair?.priceChange?.h24),
    buys: num(h24.buys) || 0, sells: num(h24.sells) || 0, txns24h: (num(h24.buys) || 0) + (num(h24.sells) || 0),
    pairCreatedAt: created ? new Date(created).toISOString() : null, ageSec: created ? Math.max(1, (Date.now() - created) / 1000) : null,
    url: pair?.url || profile?.url || `https://dexscreener.com/robinhood/${tokenAddress}`,
    website: pairWebsite(pair) || profileWebsite(profile) || null,
    socials: pair?.info?.socials || profile?.links?.filter?.(x => x?.type) || [],
    pairAddress: pair?.pairAddress || null, dexId: pair?.dexId || null, quoteSymbol: pair?.quoteToken?.symbol || null,
    boosted: Number(boost?.amount || boost?.totalAmount || 0) || 0, profiled: !!profile, source: "DEXSCREENER", updatedAt: new Date().toISOString()
  };
}
class DexScreenerProvider {
  async sync(candidateAddresses = []) {
    const [profilesR, boostsR] = await Promise.allSettled([getJson(PROFILE_URL), getJson(BOOST_URL)]);
    const profiles = (profilesR.status === "fulfilled" ? profilesR.value : []).filter(x => x?.chainId === RH && valid(x.tokenAddress));
    const boosts = (boostsR.status === "fulfilled" ? boostsR.value : []).filter(x => x?.chainId === RH && valid(x.tokenAddress));
    const pmap = new Map(profiles.map(x => [lower(x.tokenAddress), x])), bmap = new Map(boosts.map(x => [lower(x.tokenAddress), x]));
    const knownMap = new Map(KNOWN.map(x => [lower(x.address), x]));
    const addresses = [...new Set([...profiles.map(x => x.tokenAddress), ...boosts.map(x => x.tokenAddress), ...candidateAddresses, ...KNOWN.map(x => x.address)].filter(valid).map(x => String(x)))].slice(0, 120);
    const pairs = [];
    for (let i = 0; i < addresses.length; i += 30) {
      const chunk = addresses.slice(i, i + 30);
      try { const list = await getJson(TOKENS_URL + chunk.join(",")); if (Array.isArray(list)) pairs.push(...list) } catch (e) { if (!pairs.length && profilesR.status === "rejected") throw e }
    }
    const byToken = new Map();
    for (const a of addresses) {
      const candidates = pairs.filter(p => lower(p?.baseToken?.address) === lower(a));
      candidates.sort((x, y) => Number(y?.liquidity?.usd || 0) - Number(x?.liquidity?.usd || 0));
      const pair = candidates[0]; const profile = pmap.get(lower(a)); const boost = bmap.get(lower(a));
      if (pair) { const item = normalizePair(pair, a, profile, boost), known = knownMap.get(lower(a)); byToken.set(lower(a), { ...known, ...item, website: item.website || known?.website || null, url: item.url || known?.url || null }) }
      else { const known = knownMap.get(lower(a)); if (profile || known) byToken.set(lower(a), { ...known, address: a, token: a, image: profile?.icon || profile?.openGraph || known?.image || null, website: profileWebsite(profile) || known?.website || null, url: profile?.url || known?.url || `https://dexscreener.com/robinhood/${a}`, profiled: !!profile, boosted: Number(boost?.amount || 0) || 0, source: "DEXSCREENER", updatedAt: new Date().toISOString() }) }
    }
    const items = [...byToken.values()].sort((a, b) => Number(b.profiled) - Number(a.profiled) || Number(b.volume24h || 0) - Number(a.volume24h || 0) || Number(b.liquidity || 0) - Number(a.liquidity || 0));
    return { items, provider: "dexscreener", fresh: profilesR.status === "fulfilled" || pairs.length > 0, profileCount: profiles.length, boostCount: boosts.length };
  }
}

// ── GoPlus token security (api.gopluslabs.io — free, no key, covers 4663) ────
// Fields (strings): is_open_source, honeypot, cannot_sell_all, buy_tax,
// sell_tax, holder_count, lp_holder_count, is_mintable, is_proxy.
// ""/null = not yet analyzed — displayed as UNKNOWN, never as safe.
const GOPLUS_URL = "https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=";
const SECURITY_TTL_MS = 10 * 60 * 1000; // re-check every 10 min
class SecurityProvider {
  constructor() { this.cache = new Map(); this.busy = false; } // addr -> {data, at}
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
      lpHolders: raw.lp_holder_count ? Number(raw.lp_holder_count) : null,
      mintable: raw.is_mintable === "1",
      checkedAt: new Date().toISOString(),
    };
  }
  async fetchBatch(addresses) {
    const out = {};
    for (let i = 0; i < addresses.length; i += 10) {
      const chunk = addresses.slice(i, i + 10);
      try {
        const r = await fetch(`${GOPLUS_URL}${chunk.join(",")}`, { signal: AbortSignal.timeout(12000) });
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
      return Object.fromEntries([...this.cache.entries()].map(([a, d]) => [a, d]));
    } finally { this.busy = false }
  }
}

// ── Engine: state + recompute (alpha only; FOMO/copy-trading not ported) ──────
const dedupeByAddress = list => { const m = new Map(); for (const x of list) { const a = lower(x?.token || x?.address); if (!a) continue; const prev = m.get(a); if (!prev || Number(x?.liquidity || 0) > Number(prev?.liquidity || 0)) m.set(a, { ...prev, ...x }) } return [...m.values()] };

class AlphaEngine {
  constructor() {
    this.data = { updatedAt: null, status: { chain: "starting", dex: "starting" }, dexTokens: [], chain: { launches: [], trades: [], head: "0" }, alpha: [], security: {}, sources: {} };
    this.chainBusy = false; this.dexBusy = false;
    this.rh = new RobinhoodProvider({ rpcUrl: RH_RPC_URL, initialLookback: INITIAL_LOOKBACK });
    this.dex = new DexScreenerProvider();
    this.security = new SecurityProvider();
  }
  hydrate() {
    try {
      if (!existsSync(CACHE_FILE)) return;
      const c = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
      // A partial/empty cache must never erase the last-known-good discovery universe.
      this.data = {
        ...this.data,
        ...c,
        dexTokens: c.dexTokens?.length ? c.dexTokens : [],
        status: { ...(c.status || {}), chain: "starting", dex: "starting" },
      };
      if (c.chain?.launches?.length) this.data.chain = c.chain;
    } catch { /* corrupt cache — start fresh */ }
  }
  save() {
    try {
      const tmp = CACHE_FILE + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, CACHE_FILE);
    } catch { /* non-fatal */ }
  }
  async syncChain() {
    if (this.chainBusy) return; this.chainBusy = true;
    try {
      // Back off after a 429: hammering a rate-limited RPC extends the ban.
      const err = this.data.sources.chain?.error;
      if (err && String(err).includes("429")) {
        const last = new Date(this.data.sources.chain.lastAttempt || 0).getTime();
        if (Date.now() - last < 90_000) return; // cool down before retrying
      }
      const snap = await this.rh.poll(false);
      this.data.chain = snap;
      this.data.sources.chain = { fresh: true, provider: "robinhood-rpc", lastSync: new Date().toISOString() };
      this.data.status.chain = "online";
      this.recompute();
    } catch (e) {
      this.data.status.chain = "degraded";
      this.data.sources.chain = { ...(this.data.sources.chain || {}), fresh: false, error: String(e.message || e), lastAttempt: new Date().toISOString() };
    } finally { this.chainBusy = false }
  }
  async syncDex() {
    if (this.dexBusy) return; this.dexBusy = true;
    try {
      const candidates = [...(this.data.chain?.launches || []).map(x => x.token)].filter(Boolean);
      const snap = await this.dex.sync(candidates);
      if (snap.items?.length) {
        const map = new Map((this.data.dexTokens || []).map(x => [lower(x.address || x.token), x]));
        for (const x of snap.items) { const k = lower(x.address || x.token); if (k) map.set(k, { ...(map.get(k) || {}), ...x }) }
        this.data.dexTokens = [...map.values()].sort((a, b) => Number(b.volume24h || 0) - Number(a.volume24h || 0)).slice(0, 180);
      }
      this.data.sources.dex = { fresh: !!snap.fresh, provider: "dexscreener", lastSync: new Date().toISOString(), profileCount: snap.profileCount, boostCount: snap.boostCount };
      this.data.status.dex = "online";
      this.recompute();
    } catch (e) {
      this.data.status.dex = "degraded";
      this.data.sources.dex = { ...(this.data.sources.dex || {}), fresh: false, error: String(e.message || e), lastAttempt: new Date().toISOString() };
    } finally { this.dexBusy = false }
  }
  recompute() {
    const dexMap = new Map((this.data.dexTokens || []).map(x => [lower(x.address || x.token), x]));
    const launches = this.data.chain?.launches || [], now = Date.now(), launchMap = new Map();
    // Launch tokens get live trade counters from the on-chain PONS event feed.
    // Graduation cross-reference: a PONS launch is "graduated" when DexScreener
    // indexes a live pair for it — bonding-curve-only tokens aren't on
    // DexScreener, so pair presence = the launch made it to a real DEX pool.
    // LONG launches: their ONLY venue is a stock-paired V4 pool, so the
    // on-chain pool itself is the graduation signal (they're born on a DEX).
    for (const l of launches) {
      const key = lower(l.token), market = dexMap.get(key) || {};
      const isLong = (l.protocol || "").toUpperCase() === "LONG";
      const isStonk = (l.protocol || "").toUpperCase() === "STONK";
      // STONK (StonkBrokers launchpad) tokens trade through per-token V3 pools
      // via its executor — same born-on-DEX logic as LONG: the on-chain pool is
      // the graduation signal; DexScreener pair presence upgrades the display
      // data but the pool itself is the graduate proof.
      const graduated = isLong || isStonk || (!!(market.address || market.token) && (market.pairCreatedAt != null || Number(market.liquidity || 0) > 0));
      launchMap.set(key, { ...market, ...l, address: l.token, token: l.token, source: l.protocol || "PONS", buys: 0, sells: 0, uniqueBuyers: 0, quoteVolume: 0, buyerSet: new Set(), ageSec: Math.max(1, (now - new Date(l.createdAt).getTime()) / 1000), website: market.website || null, url: market.url || `https://dexscreener.com/robinhood/${l.token}`, graduated, graduatedAt: graduated ? (market.pairCreatedAt || null) : null });
    }
    for (const t of this.data.chain?.trades || []) {
      const key = lower(t.token);
      if (!launchMap.has(key)) continue;
      const x = launchMap.get(key);
      if (t.side === "BUY") { x.buys++; const w = t.wallet; if (w) x.buyerSet.add(lower(w)) }
      else if (t.side === "SELL") x.sells++;
      x.quoteVolume += Number(t.quoteAmount || 0);
    }
    // STONK launches have no PONS trade feed either (their orders route through
    // the launchpad executor, not a PONS curve) — use DexScreener 24h counters
    // like LONG.
    for (const x of launchMap.values()) {
      const proto = (x.protocol || "").toUpperCase();
      if (proto !== "LONG" && proto !== "STONK") continue;
      const m = dexMap.get(lower(x.token)) || {};
      x.buys = Number(m.buys || 0); x.sells = Number(m.sells || 0); x.quoteVolume = Number(m.volume24h || 0);
 x.uniqueBuyers = null;
    }
    const launchAlpha = [...launchMap.values()].map(x => { x.uniqueBuyers = x.buyerSet.size; delete x.buyerSet; const sec = this.data.security?.[lower(x.token)]; return { ...x, score: Math.max(tokenScore(x), marketTokenScore(x)), kind: "launch", real: true, security: sec ?? null }; });
    const launchKeys = new Set(launchAlpha.map(x => lower(x.token)));
    // Everything else on DexScreener's Robinhood profiles/boosts/markets.
    const dexAlpha = (this.data.dexTokens || []).filter(x => x.address && !launchKeys.has(lower(x.address))).map(x => { const sec = this.data.security?.[lower(x.address)]; const z = { ...x, token: x.address, protocol: x.profiled ? "DEX PROFILE" : "DEX MARKET", source: "DEXSCREENER", kind: "market", real: true, security: sec ?? null }; return { ...z, score: marketTokenScore(z) } });
    this.data.alpha = dedupeByAddress([...launchAlpha, ...dexAlpha]).sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.volume24h || 0) - Number(a.volume24h || 0)).slice(0, 100);
    this.data.updatedAt = new Date().toISOString();
  }
  // Last error across sources, for the UI's "feed offline" banner.
  lastError() {
    const c = this.data.sources.chain?.error, d = this.data.sources.dex?.error;
    const parts = [];
    if (c) parts.push(`chain: ${c}`);
    if (d) parts.push(`dexscreener: ${d}`);
    return parts.join(" · ") || null;
  }
  snapshot() { return { items: this.data.alpha, status: this.data.status, sources: this.data.sources, updatedAt: this.data.updatedAt, error: this.lastError() } }
  async syncSecurity() {
    try {
      const addrs = (this.data.alpha || []).slice(0, 100).map(t => t.address || t.token).filter(Boolean);
      const map = await this.security.sync(addrs);
      if (map) { this.data.security = map; this.recompute(); }
      this.data.sources.security = { fresh: true, provider: "goplus", lastSync: new Date().toISOString(), count: Object.keys(map || {}).length };
    } catch (e) {
      this.data.sources.security = { ...(this.data.sources.security || {}), fresh: false, error: String(e.message || e), lastAttempt: new Date().toISOString() };
    }
  }
  async start() {
    this.hydrate();
    // Warm up from cache first so the page renders instantly on restart.
    this.recompute();
    this.rh.init(this.data.chain || {}).then(s => { this.data.chain = s; this.recompute() }).catch(e => { this.data.status.chain = "degraded"; this.data.sources.chain = { fresh: false, error: e.message } });
    setTimeout(() => this.syncDex(), 1300);
    setTimeout(() => this.syncSecurity(), 6000);
    const chainTimer = setInterval(() => this.syncChain(), CHAIN_POLL_MS); chainTimer.unref();
    const dexTimer = setInterval(() => this.syncDex(), DEX_POLL_MS); dexTimer.unref();
    const secTimer = setInterval(() => this.syncSecurity(), 120000); secTimer.unref();
    const saveTimer = setInterval(() => this.save(), 60000); saveTimer.unref();
  }
}

export const alphaEngine = new AlphaEngine();
export async function startAlphaEngine() { await alphaEngine.start(); }
export function getAlphaQueue() { return alphaEngine.snapshot(); }
