import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMmConfig, decideTrade, classifyVenue } from "./mm-engine.mjs";

const cfg = normalizeMmConfig({ trade_size_usd: 25 });
const flows = { sellUsd: 0, buyUsd: 0 };
// Everything in-band, calm market: price at fair value, no external flow.
const base = {
  config: cfg, priceUsd: 100, fairValueUsd: 100,
  external: { count: 5, netUsd: -500, buysUsd: 0, sellsUsd: 500 },
  lastSide: null, lastTradeAt: null, tradesToday: 0,
  todayFlows: flows, inventoryTokens: 0, costBasisUsd: 0,
  liquidityUsd: 50_000, impactPct: 0.5, now: Date.now(),
};

test("config clamps rogue values to hard limits", () => {
  const c = normalizeMmConfig({ trade_size_usd: 99_999, cooldown_minutes: 0.001, max_impact_pct: -5, slippage_pct: 500, min_external_txns: 1.7 });
  assert.equal(c.trade_size_usd, 1000);
  assert.equal(c.cooldown_minutes, 1);
  assert.equal(c.max_impact_pct, 0.1);
  assert.equal(c.slippage_pct, 15);
  assert.equal(c.min_external_txns, 2); // rounded
});

test("price inside the quoted band never trades", () => {
  const r = decideTrade({ ...base });
  assert.equal(r.trade, null);
  assert.ok(r.blocked.some((b) => b.includes("inside band")));
});

test("external sells pushing price to the bid triggers a BUY", () => {
  const r = decideTrade({ ...base, priceUsd: 98.9 });
  assert.equal(r.trade?.side, "buy");
  assert.ok(r.trade.reason.includes("external sell"));
});

test("external buys pushing price to the ask triggers a SELL (with inventory)", () => {
  const r = decideTrade({
    ...base, priceUsd: 101.2,
    external: { count: 5, netUsd: 500, buysUsd: 500, sellsUsd: 0 },
    inventoryTokens: 3,
  });
  assert.equal(r.trade?.side, "sell");
});

test("the bot never trades WITH the flow (no self-crossing)", () => {
  // External BUY flow pushed price up through the ask — but we have no
  // inventory, and buying into a rising market is chasing, not making.
  const r = decideTrade({
    ...base, priceUsd: 101.2,
    external: { count: 5, netUsd: 500, buysUsd: 500, sellsUsd: 0 },
  });
  assert.equal(r.trade, null);
  // External BUY flow at the bid must not produce a buy either.
  const r2 = decideTrade({
    ...base, priceUsd: 98.9,
    external: { count: 5, netUsd: 500, buysUsd: 500, sellsUsd: 0 },
  });
  assert.equal(r2.trade, null);
});

test("alternation gate blocks same-side repeats", () => {
  const r = decideTrade({ ...base, priceUsd: 98.9, lastSide: "buy" });
  assert.equal(r.trade, null);
  assert.ok(r.blocked.some((b) => b.includes("alternation")));
});

test("sell-after-sell is blocked below the +30% momentum threshold", () => {
  // Last leg sell at $100; price at the ask ($101.2) but <30% above prev sell.
  const r = decideTrade({
    ...base, priceUsd: 101.2, lastSide: "sell",
    external: { count: 5, netUsd: 500, buysUsd: 500, sellsUsd: 0 },
    inventoryTokens: 3, lastSellPriceUsd: 100,
  });
  assert.equal(r.trade, null);
  assert.ok(r.blocked.some((b) => b.includes("alternation") && b.includes("<30% above prev sell")));
});

test("sell-after-sell FIRES when price ≥ +30% above the previous sell", () => {
  // Last leg sell at $100 → at $130.01 the momentum exception allows a sell.
  const r = decideTrade({
    ...base, priceUsd: 130.01, fairValueUsd: 113.05, // 130.01 ≥ 113.05*1.15 = ask
    external: { count: 5, netUsd: 500, buysUsd: 500, sellsUsd: 0 },
    inventoryTokens: 3, lastSellPriceUsd: 100,
  });
  assert.equal(r.trade?.side, "sell");
  // Exactly +30% also passes (>= comparison).
  const r2 = decideTrade({
    ...base, priceUsd: 130, fairValueUsd: 113.04,
    external: { count: 5, netUsd: 500, buysUsd: 500, sellsUsd: 0 },
    inventoryTokens: 3, lastSellPriceUsd: 100,
  });
  assert.equal(r2.trade?.side, "sell");
});

test("sell-after-sell exception requires a stored previous sell price", () => {
  // lastSide sell but lastSellPriceUsd never recorded (legacy rows) → strict
  // alternation still applies.
  const r = decideTrade({
    ...base, priceUsd: 150, fairValueUsd: 130,
    external: { count: 5, netUsd: 500, buysUsd: 500, sellsUsd: 0 },
    inventoryTokens: 3, lastSide: "sell", lastSellPriceUsd: null,
  });
  assert.equal(r.trade, null);
  assert.ok(r.blocked.some((b) => b.includes("alternation")));
});

test("buy-after-buy is NEVER allowed (exception is sell-only)", () => {
  const r = decideTrade({ ...base, priceUsd: 98.9, lastSide: "buy", lastSellPriceUsd: 200 });
  assert.equal(r.trade, null);
  assert.ok(r.blocked.some((b) => b.includes("alternation")));
});

test("cooldown blocks rapid-fire legs", () => {
  const r = decideTrade({ ...base, priceUsd: 98.9, lastTradeAt: new Date(Date.now() - 60_000).toISOString() });
  assert.equal(r.trade, null);
  assert.ok(r.blocked.some((b) => b.includes("cooldown")));
});

test("daily loss limit halts buying after net cash-out breach", () => {
  const r = decideTrade({ ...base, priceUsd: 98.9, todayFlows: { buyUsd: 100, sellUsd: 0 } });
  assert.equal(r.trade, null);
  assert.ok(r.blocked.some((b) => b.includes("loss limit")));
});

test("price-impact cap blocks the leg", () => {
  const r = decideTrade({ ...base, priceUsd: 98.9, impactPct: 5 });
  assert.equal(r.trade, null);
  assert.ok(r.blocked.some((b) => b.includes("impact")));
});

test("liquidity floor blocks everything", () => {
  const r = decideTrade({ ...base, priceUsd: 98.9, liquidityUsd: 100 });
  assert.equal(r.trade, null);
  assert.ok(r.blocked.some((b) => b.includes("liquidity")));
});

test("inventory cap shrinks or blocks the buy near the ceiling", () => {
  // 5 tokens * $98.9 = $494.5 vs $500 cap → room for ~$5.5, under the $1 floor? No: 5.5 >= 1 so size shrinks.
  const r = decideTrade({ ...base, priceUsd: 98.9, inventoryTokens: 5 });
  if (r.trade) assert.ok(r.trade.sizeUsd <= 5.6);
  else assert.ok(r.blocked.some((b) => b.includes("inventory") || b.includes("impact") || b.includes("alternation")));
  // At the cap exactly: must be blocked.
  const r2 = decideTrade({ ...base, priceUsd: 100, inventoryTokens: 5 }); // $500 = cap
  assert.ok(r2.trade === null || r2.trade.sizeUsd < 25);
});

test("sell with zero inventory is blocked", () => {
  const r = decideTrade({
    ...base, priceUsd: 101.2,
    external: { count: 5, netUsd: 500, buysUsd: 500, sellsUsd: 0 },
    inventoryTokens: 0,
  });
  assert.equal(r.trade, null);
  assert.ok(r.blocked.some((b) => b.includes("nothing to sell")));
});

test("venue classification: stock-paired pool (ATLANTIS/MU shape)", () => {
  const v = classifyVenue(
    { poolKey: { currency0: "0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18", currency1: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD" } },
    "0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18",
  );
  assert.equal(v.kind, "erc20");
  assert.equal(v.tokenIs0, true);
  assert.equal(v.quote.toLowerCase(), "0xff080c8ce2e5feadaca0da81314ae59d232d4afd");
  // ETH-quoted pool shape
  const v2 = classifyVenue(
    { poolKey: { currency0: "0x0000000000000000000000000000000000000000", currency1: "0xabc0000000000000000000000000000000000001" } },
    "0xabc0000000000000000000000000000000000001",
  );
  assert.equal(v2.kind, "eth");
  assert.equal(v2.tokenIs0, false);
});

test("size never exceeds max_trade_usd and respects inventory room", () => {
  const r = decideTrade({ ...base, priceUsd: 98.9, inventoryTokens: 4.9 }); // ~$484.6 in inventory
  if (r.trade) {
    assert.ok(r.trade.sizeUsd <= 100); // max_trade_usd
    if (r.trade.side === "buy") assert.ok(r.trade.sizeUsd <= 500 - 484.6 + 0.1, "buy respects inventory room");
  } else {
    assert.ok(r.blocked.length > 0); // legitimately gated near the cap
  }
});
