#!/usr/bin/env node
// diag-v3-venues.mjs — where is LAPTOP's liquidity actually? Dexscreener.
const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN}`);
const d = await res.json();
const pairs = d.pairs || [];
for (const p of pairs) {
  console.log(
    p.chainId, "|", p.dexId, "|", (p.labels || []).join("+"),
    "| liq$", (p.liquidity?.usd ?? "?").toLocaleString?.() ?? p.liquidity?.usd,
    "| vol24h$", p.volume?.h24, "| price$", p.priceUsd,
    "|", p.pairAddress
  );
}
console.log("total pairs:", pairs.length);
