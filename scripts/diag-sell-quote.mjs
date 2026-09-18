/**
 * diag-sell-quote.mjs — read-only rehearsal of executeSniperSell per watcher:
 * pool discovery, V4 quoter simulation, allowance state. Sends NO transactions.
 */
import * as db from "../db.mjs";
import { discoverPools } from "../sniper-swap.mjs";
import { getNetwork } from "../sniper-swap.mjs";

const CHAIN_KEY = { ethereum: "ethereum", base: "base", robinhood: "robinhood" };
const wallet = process.argv[2] ?? "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";

for (const w of db.getDipWatchers()) {
  const chain = CHAIN_KEY[w.chain] ?? w.chain;
  const label = `${w.symbol} (${chain})`;
  try {
    const disc = await discoverPools(chain, w.contract_address, "0.01");
    const pools = disc?.pools ?? [];
    console.log(`\n=== ${label} — ${pools.length} pool(s) ===`);
    for (const p of pools.slice(0, 3)) {
      console.log(`  ${p.dex} fee=${p.fee} label=${p.label ?? ""} liqUsd=${p.liquidityUsd ?? "?"} quote=${p.quoteCurrency ?? "?"} poolAddr=${p.address ?? ""} poolId=${(p.poolId ?? "").slice(0, 10)}`);
    }
  } catch (e) {
    console.log(`\n=== ${label} — discoverPools FAILED: ${e.message.slice(0, 300)}`);
  }
}
