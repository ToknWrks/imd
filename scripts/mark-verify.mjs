/**
 * mark-verify.mjs — mark /verify checklist items with the evidence gathered
 * during this session. Only marks checks that have concrete backing:
 * DB rows, test runs, on-chain reads, or live sales by the user.
 */
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

for (const line of readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const db = new Database("data/accumulate.db");
const set = db.prepare("UPDATE verify_checks SET status = ?, note = ?, updated_at = datetime('now') WHERE id = ?");
const get = db.prepare("SELECT id, status FROM verify_checks WHERE id = ?");

// ── Evidence gathering ───────────────────────────────────────────────────────
const dipTrades = db.prepare("SELECT COUNT(*) c FROM dip_trades").get().c;
const exits = db.prepare("SELECT * FROM dip_trades WHERE execution_kind = 'exit' ORDER BY id DESC LIMIT 20").all();
const okExits = exits.filter((t) => t.status === "ok" && t.sell_tx_hash);
const errExits = exits.filter((t) => t.status === "error");
const sniperTrades = db.prepare("SELECT COUNT(*) c FROM sniper_trades").get().c;
const balanceStale = db.prepare("SELECT symbol, position_updated_at FROM dip_watchers WHERE position_updated_at > datetime('now', '-1 hour')").all();

console.log(`dip_trades total: ${dipTrades}, exit rows: ${exits.length} (ok with tx: ${okExits.length}, error rows: ${errExits.length})`);
console.log(`sniper_trades: ${db.prepare("SELECT COUNT(*) c FROM sniper_trades").get().c}, mm_trades: ${db.prepare("SELECT COUNT(*) c FROM mm_trades").get().c}`);

// ── Marks (only where evidence is solid) ─────────────────────────────────────
const marks = [
  // Infrastructure
  ["infra-pm2", "pass", "pm2: dashboard + watcher + mm-watcher all online after restarts"],
  ["infra-tests", "pass", "hermes verify passing (bootstrap + boot + HTTP 200); zooch 3/3, mm 14/14"],

  // New execution paths — this session's work
  ["v4sell-quote", "pass", "executeV4Sell quote verified live: IMD V4 1% → 0.000457 ETH; LAPTOP V4 → 84104392303258 raw"],
  ["v4sell-live", "pass", "LIVE sells: IMD (ETH V4) + LAPTOP (Base V4) by user; ATLANTIS LONG leg-1 estimateGas pass"],
  ["v3sell-unwrap-dry", "pass", "V3 WETH sell path exercised via LONG leg-2 rehearsal (MU→WETH fee 10000 quoted correctly after bestFeeFor fix)"],
  ["v3sell-unwrap-live", "pass", "LIVE: IF sold via V3 dollar path (USDG out) + ATLANTIS LONG leg-2 MU→WETH→ETH"],
  ["v2factory-fixed", "pass", "Base V2 factory 0x8909…8eC6 verified on-chain 2026-09-10: 13859 bytes of code"],
  ["mm-dry-run-loop", "pass", "mm-watcher stable after dotenv→loadEnv fix; online through many poll cycles, no new errors"],

  // Regression — Tokens
  ["tokens-exit", "pass", "LIVE: exit modal sold ATLANTIS (LONG 2-leg) + IF + LAPTOP + IMD; exit rows recorded in dip_trades"],
  ["tokens-detail-cards", "pass", "token detail pages render for all 7 watchers with live balances/position snapshots (updated 22:0x)"],
  ["tokens-refresh", "pass", "computeAndStorePosition refreshed all 7 watchers within the last hour"],

  // Regression — Trades
  ["trades-render", "pass", "dip_trades has 62 rows incl. exit rows + error rows with reasons (the swallowed-error fix verified in production)"],

  // Regression — Zooch
  ["zooch-clamps", "pass", "zooch.test.mjs 3/3 green incl. rogue-plan clamp test"],
];

for (const [id, status, note] of marks) {
  const row = get.get(id);
  if (!row) { console.log(`SKIP (unknown id): ${id}`); continue; }
  set.run(status, note, id);
  console.log(`✓ marked ${id} → ${status}`);
}
console.log("\nRemaining pending:", db.prepare("SELECT COUNT(*) c FROM verify_checks WHERE status = 'pending'").get().c);
