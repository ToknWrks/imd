/**
 * mm-engine.mjs — market-making logic for the /mm tab. Pure functions over
 * live quotes: no DB, no side effects, fully unit-testable.
 *
 * Model: AMMs have no order book, so "market making" = a two-sided inventory
 * bot. It prices the token from the pool's own spot (slot0), and:
 *   - BUYS  when external selling has pushed price below fair - bid offset
 *   - SELLS when external buying has pushed price above fair + ask offset
 * The alternation + external-activity gates below are what keep this honest
 * market making rather than self-crossing volume manufacture: the bot only
 * ever trades AGAINST the most recent external flow, never trades twice on
 * the same side in a row, and pauses when it IS the market.
 */
import { getAddress } from "viem";

/** All strategy knobs, clamped to hard safety limits (Zooch-style). */
export function normalizeMmConfig(input = {}) {
  const num = (v, dflt, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  };
  return {
    // NOTE: mode ("twap") and skew_weight_pct were REMOVED 2026-09-13 — they
    // were stored and normalized but never read by decideTrade (dead surface
    // that made the config imply capabilities the engine doesn't have). The
    // columns may still exist in mm_strategies; they're inert.
    bid_offset_pct: num(input.bid_offset_pct, 1.0, 0.1, 25),
    ask_offset_pct: num(input.ask_offset_pct, 1.0, 0.1, 25),
    trade_size_usd: num(input.trade_size_usd, 25, 1, 1000),
    max_trade_usd: num(input.max_trade_usd, 100, 1, 5000),
    max_inventory_usd: num(input.max_inventory_usd, 500, 10, 50000),
    cooldown_minutes: num(input.cooldown_minutes, 10, 1, 1440),
    max_trades_per_day: Math.round(num(input.max_trades_per_day, 12, 1, 200)),
    max_impact_pct: num(input.max_impact_pct, 2.0, 0.1, 25),
    min_liquidity_usd: num(input.min_liquidity_usd, 5000, 0, 1e9),
    min_external_txns: Math.round(num(input.min_external_txns, 2, 0, 100)),
    daily_loss_limit_usd: num(input.daily_loss_limit_usd, 50, 1, 10000),
    slippage_pct: num(input.slippage_pct, 3, 0.1, 15),
  };
}

/** Classify the venue returned by findBestV4Pool. */
export function classifyVenue(venue, tokenAddress) {
  if (!venue?.poolKey) return { kind: "none", quote: null, tokenIs0: null };
  const ETH = "0x0000000000000000000000000000000000000000";
  const c0 = getAddress(venue.poolKey.currency0).toLowerCase();
  const c1 = getAddress(venue.poolKey.currency1).toLowerCase();
  const token = getAddress(tokenAddress).toLowerCase();
  const tokenIs0 = c0 === token;
  const other = tokenIs0 ? c1 : c0;
  const kind = other === ETH ? "eth" : "erc20";
  return { kind, quote: other, tokenIs0 };
}

/**
 * Token USD price from venue spot + ETH price.
 *  - ETH-quoted pool: tokenPriceUsd = ethPerToken * ethUsd
 *  - ERC-20-quoted pool (e.g. ATLANTIS/MU): quote token priced in USD
 *    externally (its own USDG pool), then tokenUsd = quoteUsd * quotePerToken.
 * `spot` = { ethPerToken, quotePerToken } — null components when unavailable.
 */
export function tokenPriceUsd({ spot, quoteKind, quoteUsd, ethUsd, decimals = 18 }) {
  if (quoteKind === "eth") {
    if (!(spot?.ethPerToken > 0) || !(ethUsd > 0)) return 0;
    return spot.ethPerToken * ethUsd;
  }
  if (quoteKind === "erc20") {
    if (!(spot?.quotePerToken > 0) || !(quoteUsd > 0)) return 0;
    return spot.quotePerToken * quoteUsd;
  }
  return 0;
}

/**
 * External-flow signal from recent pool swaps (raw list from the daemon's
 * log scan or DexScreener txn counts). Each item: { usd, side, at(ms) } where
 * side is from the POOL's perspective of EXTERNAL traders ('buy' = token out
 * of pool = trader buying). Returns { buysUsd, sellsUsd, netUsd, count }.
 */
export function summarizeExternalFlow(swaps, windowMs = 15 * 60_000) {
  const cutoff = Date.now() - windowMs;
  const recent = (swaps ?? []).filter((s) => Number(s.at ?? 0) >= cutoff && s.usd > 0);
  let buysUsd = 0, sellsUsd = 0;
  for (const s of recent) {
    if (s.side === "buy") buysUsd += s.usd;
    else sellsUsd += s.usd;
  }
  return { buysUsd, sellsUsd, netUsd: buysUsd - sellsUsd, count: recent.length };
}

/**
 * THE DECISION. Returns null when no trade should fire, else
 * { side, reason, sizeUsd, expectedImpactPct }.
 *
 * Gates (any failure → null with reason in `blocked`):
 *   1. alternation   — never the same side twice in a row (kills ping-pong);
 *                      EXCEPTION: a sell MAY follow a sell when price has run
 *                      ≥30% above the previous sell's price (`lastSellPriceUsd`)
 *                      — momentum sells, not self-crossing (the +28% SIRIUS
 *                      rally was unsellable under strict alternation)
 *   2. cooldown      — enough time since the last executed leg
 *   3. external flow — someone else must have moved the market into our
 *                      quote; the bot does not act on its own prints
 *   4. trade cap     — max_trades_per_day
 *   5. loss limit    — net realized today worse than -daily_loss_limit_usd
 *   6. inventory cap — buys blocked when inventory value at cap
 *   7. impact cap    — quoted price impact over max_impact_pct blocked
 *   8. liquidity     — pool liquidity below min_liquidity_usd blocked
 */
export function decideTrade({
  config, priceUsd, fairValueUsd, external, lastSide, lastTradeAt,
  tradesToday, todayFlows, inventoryTokens, costBasisUsd, liquidityUsd,
  impactPct, lastSellPriceUsd = null, now = Date.now(),
}) {
  const blocked = [];

  if (!(priceUsd > 0)) { blocked.push("no price"); return { trade: null, blocked }; }
  if (external.count < config.min_external_txns) blocked.push(`external txns ${external.count} < min ${config.min_external_txns}`);
  if (tradesToday >= config.max_trades_per_day) blocked.push(`daily trade cap ${tradesToday}/${config.max_trades_per_day}`);

  if (lastTradeAt) {
    const mins = (now - Date.parse(lastTradeAt)) / 60_000;
    if (mins < config.cooldown_minutes) blocked.push(`cooldown ${mins.toFixed(1)}/${config.cooldown_minutes}m`);
  }

  // Daily loss limit: net cash out today (buys exceed sells) beyond the limit
  // — at that point the bot is accumulating into a falling market, stop.
  // BUY-SIDE ONLY: an accumulation stop must never freeze sells. Blocking a
  // sell while underwater is how a -$30 day becomes a realized -100% (the
  // position can only exit when the gate says the bot may spend LESS).
  // Field names: getMmTodayFlows returns snake_case (buy_usd/sell_usd) — the
  // old camelCase reads were undefined→NaN→false, silently disabling this gate
  // (found 2026-09-13 via Grok's audit; the limit NEVER fired in production).
  const buyUsdToday = Number(todayFlows.buy_usd ?? todayFlows.buyUsd ?? 0);
  const sellUsdToday = Number(todayFlows.sell_usd ?? todayFlows.sellUsd ?? 0);
  const netCashToday = buyUsdToday - sellUsdToday;
  // NOTE: the gate itself is enforced AFTER side selection (below) so a sell is
  // never frozen by an accumulation stop — here we only compute netCashToday.

  if (!(liquidityUsd >= config.min_liquidity_usd)) {
    blocked.push(`pool liquidity $${Math.round(liquidityUsd)} < min $${config.min_liquidity_usd}`);
    return { trade: null, blocked };
  }

  // Price vs fair value: how far the market has moved from where we'd quote.
  const bidPrice = fairValueUsd * (1 - config.bid_offset_pct / 100);
  const askPrice = fairValueUsd * (1 + config.ask_offset_pct / 100);

  const wantBuy = priceUsd <= bidPrice && external.netUsd < 0;   // externals sold into us
  const wantSell = priceUsd >= askPrice && external.netUsd > 0;  // externals bought from us

  if (!wantBuy && !wantSell) {
    blocked.push(`price $${priceUsd.toPrecision(6)} inside band [${bidPrice.toPrecision(6)}, ${askPrice.toPrecision(6)}]`);
    return { trade: null, blocked };
  }

  const side = wantBuy ? "buy" : "sell";

  // Daily cash gate applies to BUYS only — but only enforce it here (after the
  // band computed a side) so a sell is never blocked by an accumulation stop.
  if (side === "buy" && netCashToday > config.daily_loss_limit_usd) {
    blocked.push(`daily loss limit hit (net -$${netCashToday.toFixed(2)} / limit -$${config.daily_loss_limit_usd.toFixed(2)}) — sells still allowed`);
    return { trade: null, blocked };
  }
  // Gate: alternation — same side twice in a row is a self-cross, skip.
  // EXCEPTION (sell-after-sell): a sell may follow a sell when price has run
  // ≥30% above the PREVIOUS SELL's price — that's momentum being monetized,
  // not the bot crossing itself (it would be selling new tokens at a price
  // far above where it last sold). Without this, rallies were unsellable:
  // last side sell ⇒ only buys could fire, and the fair-value band absorbed
  // the whole move (SIRIUS +28% never sold, 2026-09-11).
  const momentumSell = side === "sell"
    && lastSide === "sell"
    && lastSellPriceUsd > 0
    && priceUsd >= lastSellPriceUsd * 1.30;
  if (lastSide === side && !momentumSell) {
    blocked.push(momentumSell === false && side === "sell" && lastSide === "sell" && lastSellPriceUsd > 0
      ? `alternation: last leg was also sell and price $${priceUsd.toPrecision(6)} is <30% above prev sell $${lastSellPriceUsd.toPrecision(6)}`
      : `alternation: last leg was also ${side}`);
    return { trade: null, blocked };
  }

  if (impactPct > config.max_impact_pct) blocked.push(`impact ${impactPct.toFixed(2)}% > max ${config.max_impact_pct}%`);
  if (side === "sell" && !(inventoryTokens > 0)) blocked.push("nothing to sell");
  if (side === "sell" && sellUsdToday + config.trade_size_usd > config.max_inventory_usd * 2) {
    blocked.push("daily sell cap (would churn more than inventory budget today)");
  }

  if (blocked.length) return { trade: null, blocked };

  // Size: base size, skewed up when restoring balance, capped.
  let sizeUsd = config.trade_size_usd;
  const invUsd = inventoryTokens * priceUsd;
  if (side === "sell" && invUsd > config.max_inventory_usd * 0.75) {
    sizeUsd = Math.min(config.max_trade_usd, sizeUsd * 2); // heavy inventory → sell bigger
  }
  if (side === "buy") {
    const room = config.max_inventory_usd - invUsd;
    sizeUsd = Math.min(sizeUsd, Math.max(0, room));
    if (sizeUsd < 1) { blocked.push("inventory cap reached"); return { trade: null, blocked }; }
  }

  return {
    trade: {
      side,
      reason: wantBuy
        ? `external sell flow $${(-external.netUsd).toFixed(2)} pushed price to bid`
        : `external buy flow $${external.netUsd.toFixed(2)} pushed price to ask`,
      sizeUsd: Math.min(sizeUsd, config.max_trade_usd),
      expectedImpactPct: impactPct,
    },
    blocked,
  };
}
