#!/usr/bin/env node
/**
 * imd-coins.js — one-shot CLI: pull every coin from the IMD launchpad indexer
 * and print the alpha queue shape (top by score / volume).
 *
 *   node scripts/imd-coins.js [limit]
 *
 * Read-only. Data: https://imd-communitycoins-indexer.up.railway.app/graphql
 * (third-party hosted — verify against the hook before trusting for execution,
 * per CLAUDE.md "verify venue coverage before trusting a data source").
 */
const URL = process.env.IMD_INDEXER_URL || "https://imd-communitycoins-indexer.up.railway.app/graphql";
const IMD_RESERVE = (process.env.IMD_RESERVE_ADDRESS || "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7").toLowerCase();

const COINS_Q = `
  query($limit: Int!, $offset: Int!) {
    coins(orderBy: "createdAt", orderDirection: "desc", limit: $limit, offset: $offset) {
      items { address poolId symbol name creator supply initialVirtualImd virtualImd virtualCoin
              tradeCount buyCount sellCount volumeEth creatorFeesEth burnedImd lastTradeAt createdAt }
      pageInfo { hasNextPage }
    }
  }`;

const wei = v => { try { return Number(BigInt(v)) / 1e18; } catch { return 0; } };
const lower = s => String(s || "").toLowerCase();

async function gql(query, variables) {
  const r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
}

const coins = [];
let offset = 0;
for (;;) {
  const d = await gql(COINS_Q, { limit: 500, offset });
  coins.push(...d.coins.items);
  if (!d.coins.pageInfo.hasNextPage || !d.coins.items.length) break;
  offset += 500;
}

const rows = coins
  .filter(c => lower(c.address) !== IMD_RESERVE)
  .map(c => {
    const supply = BigInt(c.supply), vc = BigInt(c.virtualCoin);
    const soldPct = supply > 0n ? Math.max(0, Math.min(100, Number(supply - vc) * 100 / Number(supply))) : 0;
    const backing = Math.max(0, Number(BigInt(c.virtualImd) - BigInt(c.initialVirtualImd)) / 1e18);
    return { symbol: c.symbol, name: c.name, address: c.address, soldPct: +soldPct.toFixed(2),
             trades: c.tradeCount, buys: c.buyCount, sells: c.sellCount,
             volEth: +(wei(c.volumeEth)).toFixed(4), backingImd: +backing.toFixed(2),
             burnImd: +(wei(c.burnedImd)).toFixed(4), creator: c.creator };
  });

const limit = Number(process.argv[2] || 30);
console.log(`IMD launchpad — ${coins.length} coins (indexer: ${URL})\n`);
console.log("TOP BY 24H VOLUME:");
for (const c of [...rows].sort((a, b) => b.volEth - a.volEth).slice(0, limit))
  console.log(`  ${c.symbol.padEnd(14)} sold=${String(c.soldPct).padStart(5)}%  trades=${String(c.trades).padStart(5)}  vol=${String(c.volEth).padStart(9)} ETH  backing=${String(c.backingImd).padStart(9)} IMD  ${c.address}`);

console.log(`\nMOST SOLD (curve progress):`);
for (const c of [...rows].sort((a, b) => b.soldPct - a.soldPct).slice(0, limit))
  console.log(`  ${c.symbol.padEnd(14)} ${String(c.soldPct).padStart(5)}%  backing=${String(c.backingImd).padStart(9)} IMD  ${c.address}`);
