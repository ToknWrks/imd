/**
 * mm-watcher.mjs — always-on market-making daemon. Polls every active
 * mm_strategies row, builds a live snapshot, asks mm-engine for a decision,
 * and executes (or records a dry-run) when a leg fires.
 *
 * Run: node mm-watcher.mjs   (add to pm2 as accumulate-mm-watcher)
 *
 * Safety model (mirrors dip-watcher):
 *  - active=0 strategies are never touched (strategies start INACTIVE)
 *  - every leg is gated by mm-engine.decideTrade (alternation, cooldown,
 *    external-flow requirement, caps, loss limit, impact, liquidity)
 *  - trades execute through the verified dip-swap V4 paths only
 *  - errors increment error_streak; 5 consecutive errors auto-pauses the
 *    strategy rather than looping failed txs
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getAddress, keccak256, toHex, parseAbi } from "viem";
import { resolveMmSigner } from "./signer.mjs";
import { getMmStrategy, updateMmStrategy, insertMmTrade, getMmTodayFlows, countMmTradesToday, listMmStrategies, computeMmPosition, getMmOwnTxHashesToday } from "./mm-db.mjs";
import { normalizeMmConfig, decideTrade, summarizeExternalFlow } from "./mm-engine.mjs";
import { resolveMmVenue, getMmSnapshot, quoteImpactPct, executeMmBuy, executeMmSell, getQuoteTokenDecimals } from "./mm-swap.mjs";
import { getErc20Balance } from "./dip-swap.mjs";
import { getChain, httpClient, getAnalysisClient, getLogsClient } from "./chains.mjs";

// ── Load .env (same pattern as dip-watcher.mjs — no dotenv dependency) ───────

function loadEnv() {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), ".env");
  try {
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "").replace(/\s*#.*$/, "");
    }
  } catch {}
}

loadEnv();

const POLL_MS = 60_000; // 60s — band-based strategies don't need tighter; cut Alchemy calls 3× (rate-limit incident 2026-09-11)
const MAX_ERROR_STREAK = 5;

console.log(`[mm-watcher] started ${new Date().toISOString()} — poll every ${POLL_MS / 1000}s`);

async function tick() {
  const strategies = listMmStrategies().filter((s) => s.active === 1);
  if (!strategies.length) return;
  for (const s of strategies) {
    try {
      await runStrategy(s);
    } catch (e) {
      console.error(`[mm-watcher] ${s.symbol ?? s.token_address} error:`, e.message);
      const streak = (s.error_streak ?? 0) + 1;
      updateMmStrategy(s.id, {
        error_streak: streak,
        last_error: e.message.slice(0, 300),
        ...(streak >= MAX_ERROR_STREAK ? { active: 0 } : {}),
      });
      if (streak >= MAX_ERROR_STREAK) console.error(`[mm-watcher] ${s.symbol ?? s.token_address}: ${streak} consecutive errors — strategy AUTO-PAUSED`);
    }
  }
}

async function runStrategy(s, now = Date.now()) {
  const config = normalizeMmConfig(s);
  const chainKey = s.chain || "robinhood";
  const token = getAddress(s.token_address);
  const tag = s.symbol ?? token.slice(0, 8);

  // 1. Venue + live snapshot
  const { venue, meta, cls } = await resolveMmVenue(token, chainKey, s.venue_override || null);
  const snap = await getMmSnapshot(venue, cls, meta, chainKey);
  if (!(snap.priceUsd > 0)) {
    updateMmStrategy(s.id, { last_price_usd: null, last_error: "price unavailable (quote pool unpriced)" });
    return;
  }

  // 2. Inventory from the chain (never trust stored state over reality)
  const signer = await resolveMmSigner(chainKey);
  const invRaw = await getErc20Balance(token, signer.address, chainKey);
  const inventoryTokens = Number(invRaw) / 10 ** (meta.decimals ?? 18);

  // 3. External flow over the window: REAL per-trade USD sizes from the
  //    venue's own Swap logs (see getExternalFlow).
  const external = await getExternalFlow(token, chainKey, venue, snap, signer, config.min_external_txns, s.id);

  // 4. Fair value: time-based EMA stored on the strategy row (fair_value_usd /
  //    fair_value_at). Weight decays with WALL-CLOCK time since the anchor was
  //    last updated, tau = 2h — a price that drifts slowly gets absorbed into
  //    fair value (trend tracking), but a fast dip lands outside the band
  //    before the anchor can chase it. Falls back to spot on first sight.
  const fair = advanceFairValue(s, snap.priceUsd, now);
  const fairValueUsd = fair.value;

  // 5. Decide
  const { trade, blocked } = decideTrade({
    config,
    priceUsd: snap.priceUsd,
    fairValueUsd,
    external,
    lastSide: s.last_side,
    lastTradeAt: s.last_trade_at,
    tradesToday: countMmTradesToday(s.id),
    todayFlows: getMmTodayFlows(s.id),
    inventoryTokens,
    costBasisUsd: s.cost_basis_usd ?? 0,
    liquidityUsd: snap.liquidityUsd,
    impactPct: await quoteImpactPct({ venue, cls, tokenMeta: meta, chainKey, side: external.netUsd < 0 ? "buy" : "sell", usdSize: config.trade_size_usd, priceUsd: snap.priceUsd, quoteUsd: snap.quoteUsd }),
    lastSellPriceUsd: s.last_sell_price_usd ?? null,
  });

  // Always record the observed price so the dashboard's last-price display
  // advances, and persist the advanced fair-value anchor.
  updateMmStrategy(s.id, { last_price_usd: snap.priceUsd, fair_value_usd: fair.value, fair_value_at: fair.at });

  if (!trade) {
    if (blocked.length) console.log(`[mm-watcher] ${tag}: idle (${blocked[0]})`);
    return;
  }

  // 6. Execute (pass inventory so sells are sized against real balance)
  console.log(`[mm-watcher] ${tag}: ${trade.side.toUpperCase()} $${trade.sizeUsd.toFixed(2)} — ${trade.reason}`);
  const result = await executeLeg({ s, chainKey, venue, cls: { ...cls, tokenAddress: token }, meta, trade, snap, signer, inventoryTokens });
  if (result.recorded) {
    console.log(`[mm-watcher] ${tag}: ${trade.side} ${result.dryRun ? "(dry-run) " : ""}ok${result.txHash ? " tx " + result.txHash : ""}`);
  }
}

/**
 * External flow: REAL per-trade sizes from the venue's own Swap logs
 * (eth_getLogs over the window, endBlock = latest). Replaces the old
 * DexScreener txn-count proxy — on 4663 those counts were frequently 0/absent
 * (ATLANTIS + IF blocked ~forever on "external txns 0 < min 2", 2026-09-11),
 * and the $25-per-txn estimate fabricated magnitude.
 *
 * Swap event shapes:
 *  - V4 PoolManager: Swap(bytes32 indexed id, address indexed sender,
 *    int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity,
 *    int24 tick, uint24 fee)
 *  - V3 pool: Swap(address indexed sender, address indexed recipient,
 *    int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity,
 *    int24 tick)
 * Sign convention (both): negative amountX = pool→trader (trader received X).
 * The token's side decides direction: token amount negative ⇒ trader bought
 * the token out of the pool. USD sizing uses the quote deltas. The bot's own
 * legs are NOT excluded per-tx (sender attribution would cost a receipt per
 * log) — the engine's alternation gate + min_external_txns ≥ 2 bound the
 * residual self-influence; see the note at the bottom of the function.
 */
const POOL_MANAGER_SWAP_ABI = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
const V3_POOL_SWAP_ABI = parseAbi([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);
const SWAP_TOPIC_V4 = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const SWAP_TOPIC_V3 = keccak256(toHex("Swap(address,address,int256,int256,uint160,uint128,int24)"));
const ETH_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function getExternalFlow(token, chainKey, venue, snap, signer, minCount = 0, strategyId = null) {
  try {
    const dep = getChain(chainKey);
    // Full-range getLogs client: Alchemy's free tier caps eth_getLogs at a
    // 10-block range on Robinhood ("JSON is not a valid request object" was
    // Alchemy's range-cap rejection wearing a viem wrapper, 2026-09-11) while
    // the public chain RPC serves wide ranges. getLogsClient() resolves to the
    // right endpoint per chain.
    const c = getLogsClient(chainKey);
    const WINDOW_MS = 15 * 60_000;
    const latest = await c.getBlockNumber(); // viem returns bigint
    const latestNum = Number(latest);
    // Block time estimate: timestamp delta over a 50-block lookback, clamped
    // to 1s minimum (irregular ~37s blocks on 4663, fast blocks elsewhere).
    const refBlock = await c.getBlock({ blockNumber: BigInt(Math.max(1, latestNum - 50)) });
    const secPerBlock = Math.max(1, (Number(refBlock.timestamp) ? (Date.now() / 1000 - Number(refBlock.timestamp)) / Math.min(50, latestNum - 1) : 2));
    const lookbackBlocks = Math.min(Math.max(1, Math.ceil(WINDOW_MS / 1000 / secPerBlock)), 7200); // hard cap ~2h of blocks

    const tokenLower = getAddress(token).toLowerCase();
    const tokenIs0 = getAddress(venue.poolKey.currency0).toLowerCase() === tokenLower;
    const quoteCurrency = tokenIs0 ? venue.poolKey.currency1 : venue.poolKey.currency0;
    // Quote decimals: native ETH has no decimals() read — 18 fixed; ERC-20
    // quotes resolve via the cached decimals helper.
    const quoteIsEth = getAddress(quoteCurrency).toLowerCase() === ETH_ADDRESS;
    const quoteDec = quoteIsEth ? 18 : await getQuoteTokenDecimals(quoteCurrency, chainKey);
    const quoteUsd = snap.quoteUsd;
    const ethUsd = snap.ethUsd;

    // Log filter: V4 → poolId via typed event args; V3 → pool address.
    // IMPORTANT: viem's getLogs DROPS a bare `topics: [t0, t1]` string array
    // and sends topics:[] (verified via a fetch tap, 2026-09-11) — the typed
    // `event + args` shape is required for the poolId filter to be sent.
    const isV4 = venue.kind !== "v3";
    const filter = isV4
      ? { address: dep.v4.poolManager, event: POOL_MANAGER_SWAP_ABI[0], args: { id: venue.poolId }, fromBlock: BigInt(latestNum - lookbackBlocks), toBlock: latest }
      : { address: venue.address, event: V3_POOL_SWAP_ABI[0], fromBlock: BigInt(latestNum - lookbackBlocks), toBlock: latest };
    const logs = await c.getLogs(filter);

    // Exclude the bot's OWN prints: hash-set of today's executed MM legs (a
    // cheap indexed DB read — no per-log receipts needed). Without this a thin
    // pool reads the bot's own $25 buy as external buy-flow, letting the bot
    // walk its own band after cooldown (delayed self-crossing — Grok audit,
    // 2026-09-13). V4 Swap.sender is the Universal Router for every UR swap
    // (constant per chain), so sender attribution in the log is useless; the
    // tx-hash join is the reliable marker of "this print is ours".
    const ownHashes = new Set(strategyId ? getMmOwnTxHashesToday(strategyId) : []);

    let buysUsd = 0, sellsUsd = 0, count = 0;
    for (const log of logs) {
      if (ownHashes.has(String(log.transactionHash ?? "").toLowerCase())) continue; // our own leg
      // amount0/amount1 are int128 (V4) / int256 (V3) — the first two 32-byte
      // words of the log data. Negative = pool→trader (trader received it).
      // Some RPCs return `data: "0x"` for empty data — skip those.
      if (!log.data || log.data.length < 130) continue;
      const data = log.data.slice(2);
      // INTERPRET AS SIGNED (the watcher's plain BigInt("0x…") treated
      // negative int128s as ~1.16e40-raw magnitudes — a $1.87e74 "sell flow"):
      // a word ≥ 2^255 is negative; magnitude = 2^256 − word.
      const u0 = BigInt("0x" + data.slice(0, 64));
      const u1 = BigInt("0x" + data.slice(64, 128));
      const s0 = u0 >= (1n << 255n) ? -( (1n << 256n) - u0) : u0;
      const s1 = u1 >= (1n << 255n) ? -( (1n << 256n) - u1) : u1;
      // Token side sign: positive = pool gained token (external SOLD in),
      //                  negative = pool lost token (external BOUGHT out).
      const tokenSign = tokenIs0 ? (s0 >= 0n ? 1n : -1n) : (s1 >= 0n ? 1n : -1n);
      const mag0 = s0 < 0n ? -s0 : s0;
      const mag1 = s1 < 0n ? -s1 : s1;
      const quoteMag = Number(tokenIs0 ? mag1 : mag0);
      const quoteUsdValue = (quoteMag / 10 ** quoteDec) * (quoteIsEth ? (ethUsd || quoteUsd || 0) : (quoteUsd || 0));
      if (!(quoteUsdValue > 0)) continue;
      if (tokenSign < 0n) buysUsd += quoteUsdValue; else sellsUsd += quoteUsdValue;
      count++;
    }

    // Self-print note: the bot's own legs are excluded by tx-hash join above
    // (mm_trades of today vs the log's transactionHash) — no per-log receipt
    // cost, and V4 Swap.sender is the Universal Router for all UR swaps so
    // sender attribution inside the log is useless. Keep min_external_txns ≥ 2
    // anyway: it bounds one whale print satisfying the flow gate alone.
    return { buysUsd, sellsUsd, netUsd: buysUsd - sellsUsd, count, source: `swaplogs-${lookbackBlocks}b` };
  } catch (e) {
    // Surface the failure instead of silently reading 0 — a silent zero here
    // looked like "no flow" when the real problem was the scan dying.
    console.log(`[mm-watcher] external-flow scan failed: ${String(e.message ?? e).slice(0, 120)}`);
    return { buysUsd: 0, sellsUsd: 0, netUsd: 0, count: 0, source: "unavailable" };
  }
}

/** Execute one leg and record the trade. Returns { recorded: true, txHash? } */
async function executeLeg({ s, chainKey, venue, cls, meta, trade, snap, signer, inventoryTokens }) {
  const config = normalizeMmConfig(s);
  const dryRun = s.dry_run === 1;
  const token = getAddress(s.token_address);

  // Failed legs MUST reach the ledger — a revert that records nothing makes
  // "broken" and "never ran" indistinguishable (the Sniper VERIFY FAILED lesson,
  // unfixed in the MM path until the HASH sell reverts of 2026-09-13: the buy
  // row looked like the whole story while five V4TooLittleReceived reverts left
  // zero trace). The catch below wraps both sides; error rows carry
  // status='error' so computeMmPosition (which filters status='ok') ignores them.
  try {
    return await runLeg({ s, chainKey, venue, cls, meta, trade, snap, signer, inventoryTokens, config, dryRun });
  } catch (e) {
    const msg = String(e.message ?? e).slice(0, 300);
    insertMmTrade({
      strategy_id: s.id, side: trade.side, dry_run: dryRun ? 1 : 0,
      reason: trade.reason, status: "error", error: msg,
    });
    throw e;
  }
}

async function runLeg({ s, chainKey, venue, cls, meta, trade, snap, signer, inventoryTokens, config, dryRun }) {
  const token = getAddress(s.token_address);

  if (trade.side === "buy") {
    const res = await executeMmBuy({
      signer, chainKey, venue, cls, tokenMeta: meta,
      usdSize: trade.sizeUsd, priceUsd: snap.priceUsd, quoteUsd: snap.quoteUsd,
      slippagePct: config.slippage_pct, dryRun,
    });
    const tokenAmount = Number(res.quotedOut ?? 0n) / 10 ** (meta.decimals ?? 18);
    const priceUsd = tokenAmount > 0 ? trade.sizeUsd / tokenAmount : snap.priceUsd;
    insertMmTrade({
      strategy_id: s.id, side: "buy", dry_run: res.dryRun ? 1 : 0,
      reason: trade.reason, usd_size: trade.sizeUsd, token_amount: tokenAmount,
      price_usd: priceUsd, eth_amount: cls.kind === "eth" ? trade.sizeUsd / (snap.quoteUsd || 1) : null,
      tx_hash: res.txHash ?? null, status: "ok",
    });
    updateMmStrategy(s.id, {
      last_side: "buy", last_trade_at: new Date().toISOString(),
      last_sell_price_usd: null, // a buy resets the momentum-sell reference
      inventory_tokens: await chainTokenBalance(s, chainKey, meta.decimals ?? 18),
      cost_basis_usd: computeMmPosition(s.id).costBasisUsd,
      error_streak: 0, last_error: null,
    });
    return { recorded: true, dryRun, txHash: res.txHash };
  }

  // SELL: size in tokens = usdSize / price, never more than we hold
  const amountTokens = Math.min(trade.sizeUsd / snap.priceUsd, inventoryTokens);
  if (!(amountTokens > 0)) throw new Error("sell leg computed zero token amount");
  const res = await executeMmSell({
    signer, chainKey, venue, cls, tokenMeta: meta,
    amountTokensHuman: amountTokens, quoteUsd: snap.quoteUsd,
    slippagePct: config.slippage_pct, dryRun,
  });
  const quoteDecimals = cls.kind === "eth"
    ? 18
    : (String(cls.quote).toLowerCase() === String(getChain(chainKey).dollar || "").toLowerCase()
        ? (getChain(chainKey).dollarDecimals ?? 18)   // USDG/USDC quote — 6 decimals
        : 18);
  const quoteReceivedUsd = (Number(res.quotedOut ?? 0n) / 10 ** quoteDecimals) * (snap.quoteUsd || 1);
  // Book ACTUAL proceeds (quote re-denominated to USD), not the intended clip.
  // The old row wrote usd_size: trade.sizeUsd + price_usd: snap.priceUsd —
  // realized P/L became "what we meant to get," and on thin/impact-y pools the
  // gap vs reality is the whole story (found via Grok's audit 2026-09-13).
  // price_usd = realized avg price = proceeds / tokens sold.
  insertMmTrade({
    strategy_id: s.id, side: "sell", dry_run: res.dryRun ? 1 : 0,
    reason: trade.reason, usd_size: quoteReceivedUsd, token_amount: amountTokens,
    price_usd: amountTokens > 0 ? quoteReceivedUsd / amountTokens : snap.priceUsd, eth_amount: cls.kind === "eth" ? quoteReceivedUsd / (snap.ethUsd || 1) : null,
    tx_hash: res.txHash ?? null, status: "ok",
  });
  const posAfter = computeMmPosition(s.id); // ledger is the source of truth (self-heals stale rows)
  updateMmStrategy(s.id, {
    last_side: "sell", last_trade_at: new Date().toISOString(),
    last_sell_price_usd: snap.priceUsd, // reference for the sell-after-sell exception
    inventory_tokens: await chainTokenBalance(s, chainKey, meta.decimals ?? 18),
    cost_basis_usd: posAfter.costBasisUsd,
    realized_pl_usd: posAfter.realizedPlUsd,
    error_streak: 0, last_error: null,
  });
  return { recorded: true, dryRun, txHash: res.txHash };
}

// ── fair-value anchor ────────────────────────────────────────────────────────

// Time constant of the fair-value EMA. 2h: slow enough that a dip that plays
// out over minutes-to-an-hour still exits the band; fast enough that the
// anchor eventually follows a genuine re-rating instead of quoting a stale
// price forever.
const FAIR_VALUE_TAU_MS = 2 * 60 * 60_000;

/**
 * Advance the fair-value anchor. Exponential smoothing weighted by elapsed
 * wall-clock time: weight w = 1 - exp(-dt/tau), fair' = fair*(1-w) + spot*w.
 *   - 1 min between updates → w ≈ 0.8%  (anchor barely moves — dips stand out)
 *   - 2 h  between updates → w ≈ 63%
 *   - first ever update / anchor unset → anchor = spot (w = 1)
 *   - a long daemon sleep re-anchors quickly (dt large → w → 1) instead of
 *     compounding a stale value; the anchor converges to the market over hours
 */
export function advanceFairValue(s, spotPriceUsd, nowMs = Date.now()) {
  const prev = Number(s.fair_value_usd);
  if (!(spotPriceUsd > 0)) {
    // No spot this tick — keep the anchor untouched, just carry its timestamp.
    return { value: prev > 0 ? prev : 0, at: s.fair_value_at ?? new Date(nowMs).toISOString() };
  }
  if (!(prev > 0)) return { value: spotPriceUsd, at: new Date(nowMs).toISOString() };
  const prevAt = s.fair_value_at ? Date.parse(s.fair_value_at) : NaN;
  const dt = Number.isFinite(prevAt) ? Math.max(0, nowMs - prevAt) : FAIR_VALUE_TAU_MS;
  const w = 1 - Math.exp(-dt / FAIR_VALUE_TAU_MS);
  return { value: prev * (1 - w) + spotPriceUsd * w, at: new Date(nowMs).toISOString() };
}

// ── position helpers ─────────────────────────────────────────────────────────

/** Actual token balance of the MM wallet, human units (inventory = reality). */
async function chainTokenBalance(s, chainKey, decimals = 18) {
  try {
    const signer = await resolveMmSigner(chainKey);
    const raw = await getErc20Balance(s.token_address, signer.address, chainKey);
    return Number(raw) / 10 ** decimals;
  } catch { return null; }
}

/** Boot-time self-heal: reconcile every strategy's position from its ledger. */
async function reconcileAll() {
  for (const s of listMmStrategies()) {
    try {
      const pos = computeMmPosition(s.id);
      const patch = {
        cost_basis_usd: pos.costBasisUsd,
        realized_pl_usd: pos.realizedPlUsd,
      };
      const bal = await chainTokenBalance(s, s.chain || "robinhood", s.decimals ?? 18);
      if (bal != null) patch.inventory_tokens = bal;
      updateMmStrategy(s.id, patch);
      if (s.realized_pl_usd !== pos.realizedPlUsd || s.cost_basis_usd !== pos.costBasisUsd) {
        console.log(`[mm-watcher] ${s.symbol ?? s.id}: reconciled from ledger — basis $${pos.costBasisUsd.toFixed(2)}, realized P/L $${pos.realizedPlUsd.toFixed(2)}`);
      }
    } catch (e) { console.error(`[mm-watcher] reconcile ${s.symbol}:`, e.message); }
  }
}

async function loop() {
  while (true) {
    const started = Date.now();
    try { await tick(); } catch (e) { console.error("[mm-watcher] tick error:", e.message); }
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(1000, POLL_MS - elapsed)));
  }
}

reconcileAll().catch((e) => console.error("[mm-watcher] reconcile:", e.message));
loop().catch((e) => { console.error("[mm-watcher] fatal:", e); process.exit(1); });
