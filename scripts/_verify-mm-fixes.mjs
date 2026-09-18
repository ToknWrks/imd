/** Read-only verification of the two MM fixes (no trades, no DB writes). */
import { resolveMmVenue, getMmSnapshot } from "../mm-swap.mjs";
import { advanceFairValue } from "../mm-watcher.mjs";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const IF = "0x232CDFc415D10b673845D83Dc02ba2eaBe7e30d1";
const SIRIUS = "0x3b4a0048a00787a644932cd648faa043410c163e";

// ── Fix 2: liquidity reads for IF (native-ETH V4 pool, currency0 = 0x0) ──
const { venue, cls, meta } = await resolveMmVenue(IF, "robinhood", null);
console.log("IF venue:", venue.kind, venue.poolId?.slice(0, 14), "cur0 =", venue.poolKey.currency0);
const snap = await getMmSnapshot(venue, cls, meta, "robinhood");
console.log("IF snapshot: priceUsd =", snap.priceUsd.toPrecision(6), "liquidityUsd =", snap.liquidityUsd);
if (!(snap.liquidityUsd > 0)) { console.error("FAIL: IF liquidity still $0"); process.exit(1); }
console.log("PASS: IF liquidity now reads", snap.liquidityUsd);

// ── Fix 1: fair-value anchor behavior ─────────────────────────────────────
const t0 = Date.now();
// First sight: anchor = spot
let a = advanceFairValue({ fair_value_usd: null, fair_value_at: null }, 1.0, t0);
console.log("first sight:", a.value, "(expect 1.0)");
// 1 minute later, price dips 20%: anchor should move only ~0.8%
const t1 = t0 + 60_000;
a = advanceFairValue({ fair_value_usd: a.value, fair_value_at: a.at }, 0.8, t1);
const after1min = a.value;
console.log("after 1min @ $0.80:", after1min.toPrecision(6), "(expect ~0.9984 — dip stands out)");
if (Math.abs(after1min - 0.9984) > 0.001) { console.error("FAIL: 1-min anchor moved too much"); process.exit(1); }
// 4 hours of drifting at $0.80 (simulating repeated polls): anchor must converge
let s = { fair_value_usd: after1min, fair_value_at: new Date(t1).toISOString() };
let t = t1;
for (let i = 0; i < 240; i++) { t += 60_000; s = advanceFairValue(s, 0.8, t); }
console.log("after 4h @ $0.80:", s.value.toPrecision(6), "(expect ≈0.8 — anchor follows a real re-rating)");
if (Math.abs(s.value - 0.8) > 0.05) { console.error("FAIL: anchor did not converge over 4h"); process.exit(1); }
// tau sanity
console.log("tau: 2 h (hardcoded in mm-watcher.mjs)");
console.log("ALL PASS");
process.exit(0);
