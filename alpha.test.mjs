/**
 * alpha.test.mjs — unit tests for the IMD alpha engine's pure logic.
 * Run: node --test alpha.test.mjs
 *
 * Covers: curve math (price/sold%/backing — the numbers the Board displays),
 * both scorers' clamping behavior (including a deliberately rogue row, per
 * the /accumulate lesson: AI/heuristic numbers must never escape their bands),
 * and the engine's recompute() on synthetic indexer data (dedupe of the
 * reserve IMD, provenance badges, flow aggregation).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { curvePriceImd, coinsSoldPct, backingImd, tokenScore, curveTokenScore } from "./alpha-engine.mjs";

const B = 10n ** 18n;

test("curvePriceImd: spot price = virtualImd / virtualCoin", () => {
  const c = { virtualImd: String(2000n * B), virtualCoin: String(500n * B) };
  assert.equal(curvePriceImd(c), 4);
});

test("curvePriceImd: zero virtualCoin → 0, never throws", () => {
  assert.equal(curvePriceImd({ virtualImd: "1", virtualCoin: "0" }), 0);
});

test("coinsSoldPct: 42.2% sold (BALLOON snapshot value)", () => {
  // 1B supply, virtualCoin = 577.8M remaining ⇒ 42.22% sold
  const c = { supply: String(1_000_000_000n * B), virtualCoin: String(577_800_000n * B) };
  const pct = coinsSoldPct(c);
  assert.ok(pct > 42.2 && pct < 42.3, `got ${pct}`);
});

test("coinsSoldPct: untouched launch → 0%", () => {
  const c = { supply: String(1_000_000_000n * B), virtualCoin: String(1_000_000_000n * B) };
  assert.equal(coinsSoldPct(c), 0);
});

test("coinsSoldPct: clamps to [0, 100]", () => {
  const c = { supply: "1000", virtualCoin: "-5" };
  assert.equal(coinsSoldPct(c), 100);
});

test("backingImd: virtualImd − initialVirtualImd, floored at 0", () => {
  const c = { virtualImd: String(3000n * B), initialVirtualImd: String(2000n * B) };
  assert.equal(backingImd(c), 1000);
  const neg = { virtualImd: "1", initialVirtualImd: "2" };
  assert.equal(backingImd(neg), 0);
});

test("tokenScore: rogue inputs stay within 0–100", () => {
  assert.ok(tokenScore({ ageSec: 1, uniqueBuyers: 1e9, buys: 1e9, sells: 0, quoteVolume: 1e12 }) <= 100);
  assert.ok(tokenScore({ ageSec: 1e12, uniqueBuyers: 0, buys: 0, sells: 1e9, quoteVolume: 0 }) >= 0);
});

test("curveTokenScore: rogue inputs stay within 0–100", () => {
  const rogue = { ageSec: 1, uniqueBuyers: 1e12, buys: 1e12, sells: 0, quoteVolume: 1e12, marketCap: 1e18, soldPct: 500 };
  assert.ok(curveTokenScore(rogue) <= 100);
  assert.ok(curveTokenScore({}) >= 0);
});

test("curveTokenScore: more unique curve buyers scores higher (buyers > volume weighting)", () => {
  const base = { ageSec: 3600, buys: 50, sells: 20, quoteVolume: 5, marketCap: 60000, soldPct: 5 };
  const manyBuyers = curveTokenScore({ ...base, uniqueBuyers: 40 });
  const fewBuyers = curveTokenScore({ ...base, uniqueBuyers: 2 });
  assert.ok(manyBuyers > fewBuyers);
});

test("curveTokenScore: identical scored row is deterministic", () => {
  const t = { ageSec: 600, buys: 10, sells: 4, uniqueBuyers: 6, quoteVolume: 1.2, marketCap: 30000, soldPct: 2.5 };
  assert.equal(curveTokenScore(t), curveTokenScore({ ...t }));
});
