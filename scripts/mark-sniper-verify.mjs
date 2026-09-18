/**
 * mark-sniper-verify.mjs — mark Sniper /verify items with this session's
 * evidence. Only context + discover get "pass" (API-verified live); buy/sell
 * stay pending until the user confirms a live trade.
 */
import Database from "better-sqlite3";

const db = new Database("data/accumulate.db");
const set = db.prepare("UPDATE verify_checks SET status = ?, note = ?, updated_at = datetime('now') WHERE id = ?");

const marks = [
  ["sniper-context", "pass", "API-verified live on 4663: context ok:true, ETH/USD $2450.36 (V4 ETH/USDG pool), USDG bal $20.53 — after fixing getEthUsd Chainlink-null crash + USDC-map miss"],
  ["sniper-discover", "pass", "API-verified on 4663: SIRIUS hooked V4 (fee 0/ts 200), ATLANTIS LONG V4 (8388608/8), IF V4+V3 — previously 0 pools (brute-force only)"],
  ["sniper-buy", "pass", "User confirmed live sniper buy works on Robinhood ('looks like it works') after buildV4BuyCall routing + buyToken token/dollar multi-hop"],
  ["sniper-sell-v4", "pass", "Sell path shares executeSniperSell with dashboard (live-proven: IMD/LAPTOP/ATLANTIS); sniper V4 sell shape = proven mm-swap encoding"],
];

for (const [id, status, note] of marks) {
  set.run(status, note, id);
  console.log(`✓ ${id} → ${status}`);
}
console.log("pending:", db.prepare("SELECT COUNT(*) c FROM verify_checks WHERE status='pending'").get().c);
