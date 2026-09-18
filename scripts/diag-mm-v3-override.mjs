/**
 * diag-mm-v3-override.mjs — verify the V3-venue support for MM: resolve the
 * IF/USDG V3 pool override, snapshot it, and run both quote directions.
 * Read-only.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

for (const line of readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const mm = await import("../mm-swap.mjs");
const IF = "0x232CDFc415D10b673845D83Dc02ba2eaBe7e30d1";
const V3POOL = "0x39A200271525E9641e799127bdAB299DAeF21953";

const { venue, meta, cls } = await mm.resolveMmVenue(IF, "robinhood", V3POOL);
console.log(`venue: kind=${venue.kind} addr=${venue.address} fee=${venue.fee}`);
console.log(`cls: tokenIs0=${cls.tokenIs0} kind=${cls.kind} quote=${cls.quote.slice(0, 10)}`);

const snap = await mm.getMmSnapshot(venue, cls, meta, "robinhood");
console.log(`snapshot: priceUsd=${snap.priceUsd} quoteSymbol=${snap.quoteSymbol} liqUsd=${Math.round(snap.liquidityUsd ?? 0)}`);

const amountIn = BigInt(Math.round((5 / snap.priceUsd) * 10 ** Number(meta.decimals ?? 18)));
const buyQ = await mm.quoteExactInOnVenue(venue, cls.quote, amountIn, "robinhood");
console.log(`buy quote: $5 → ${Number(buyQ) / 10 ** Number(meta.decimals ?? 18)} IF`);

const sellQ = await mm.quoteExactInOnVenue(venue, cls.tokenAddress, amountIn, "robinhood");
console.log(`sell quote: ${Number(amountIn) / 10 ** 18} IF → ${Number(sellQ) / 1e6} USDG`);

const impact = await mm.quoteImpactPct({ venue, cls, tokenMeta: meta, chainKey: "robinhood", side: "sell", usdSize: 5, priceUsd: snap.priceUsd, quoteUsd: snap.quoteUsd });
console.log(`impact ($5 sell): ${impact}%`);
