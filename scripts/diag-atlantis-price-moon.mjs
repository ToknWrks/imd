/**
 * diag-atlantis-price-moon.mjs — who moved ATLANTIS 49×?
 * Checks: current slot0, MM snapshot, dip-watcher's executed trades on
 * ATLANTIS (dip/scheduled buys), sniper trades since 23:30, wallet state.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

for (const line of readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { getChain } = await import("../chains.mjs");
const { createPublicClient, http, parseAbi, formatUnits } = await import("viem");
const dep = getChain("robinhood");
const c = createPublicClient({ transport: http(dep.httpRpc()) });

const POOL_ID = "0xac3ed4bca616d07d9b5771a88e05f698eb66fe4be7764ff3cffb1674af0bc039";
const SV = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"]);
const s0 = await c.readContract({ address: dep.v4.stateView, abi: SV, functionName: "getSlot0", args: [POOL_ID] });
const s2 = (Number(s0[0]) / 2 ** 96) ** 2;
console.log(`current slot0: s² = ${s2.toExponential(6)} MU/ATL · tick = ${s0[1]} · lpFee = ${Number(s0[3])}`);

const mm = await import("../mm-swap.mjs");
const { venue, meta, cls } = await mm.resolveMmVenue("0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18", "robinhood", null);
const snap = await mm.getMmSnapshot(venue, cls, meta, "robinhood");
console.log(`MM snapshot now: priceUsd=${snap.priceUsd} quoteUsd(MU)=${snap.quoteUsd?.toFixed?.(2)}`);

// dip-watcher trades on ATLANTIS
const db = (await import("better-sqlite3")).default;
const Database = db;
const conn = new Database("data/accumulate.db", { readonly: true });
const atlWatcher = conn.prepare("SELECT id, symbol, threshold_usd, buy_amount_usd, active FROM dip_watchers WHERE symbol='ATLANTIS'").get();
console.log("\ndip-watcher row:", JSON.stringify(atlWatcher));
if (atlWatcher) {
  const trades = conn.prepare("SELECT * FROM dip_trades WHERE watcher_id=? ORDER BY id DESC LIMIT 10").all(atlWatcher.id);
  console.log(`dip_trades for ATLANTIS: ${trades.length} (recent)`);
  for (const t of trades) console.log(`  ${t.created_at} kind=${t.execution_kind} status=${t.status} eth_spent=${t.eth_spent} tokens=${t.token_amount} err=${(t.error ?? "").slice(0, 50)}`);
}

// sniper trades since 23:30
const sniper = conn.prepare("SELECT created_at, dex, eth_spent, token_amount FROM sniper_trades WHERE symbol='ATLANTIS' AND created_at > '2026-09-10 23:30' ORDER BY id").all();
console.log("\nsniper trades since 23:30:", sniper.length);
for (const t of sniper) console.log(`  ${t.created_at} ${t.dex} eth=${t.eth_spent} tokens=${t.token_amount}`);
