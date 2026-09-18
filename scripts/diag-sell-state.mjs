import * as db from "../db.mjs";
const watchers = db.getDipWatchers();
for (const w of watchers) {
  console.log(`${w.symbol} | chain=${w.chain} | addr=${w.contract_address} | balance=${w.wallet_balance} | priceUsd=${w.price_usd} | active=${w.active} | pool=${w.pool_address ?? "auto"}`);
}
console.log("--- recent trades ---");
for (const t of db.getDipTrades(15)) {
  console.log(JSON.stringify({ id: t.id, watcher: t.watcher_id, kind: t.execution_kind, status: t.status, token_amount: t.token_amount, error: (t.error ?? "").slice(0, 200), created: t.created_at }));
}
