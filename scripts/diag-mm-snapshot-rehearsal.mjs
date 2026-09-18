/**
 * diag-mm-snapshot-rehearsal.mjs — verify the MM pipeline for SIRIUS
 * (hooked token/dollar pool on Robinhood) up to but NOT including any send:
 * venue resolution, classification, snapshot pricing, impact quote, and
 * engine decision. Read-only.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

for (const line of readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { resolveMmVenue, getMmSnapshot, quoteImpactPct } = await import("../mm-swap.mjs");
const { decideTrade, normalizeMmConfig } = await import("../mm-engine.mjs");
const { getMmStrategy } = await import("../mm-db.mjs");

const SIRIUS = "0x3b4a0048a00787a644932cd648faa043410c163e";

const { venue, meta, cls } = await resolveMmVenue(SIRIUS, "robinhood", null);
console.log(`venue: fee=${venue.poolKey.fee} ts=${venue.poolKey.tickSpacing} hooks=${venue.poolKey.hooks.slice(0, 10)}`);
console.log(`classification: tokenIs0=${cls.tokenIs0} kind=${cls.kind} quote=${cls.quote.slice(0, 10)}`);

const snap = await getMmSnapshot(venue, cls, meta, "robinhood");
console.log(`snapshot: priceUsd=${snap.priceUsd?.toExponential?.(4)} quoteUsd=${snap.quoteUsd} liqUsd=${Math.round(snap.liquidityUsd ?? 0)} quoteSymbol=${snap.quoteSymbol}`);

const impact = await quoteImpactPctSafe();
async function quoteImpactPctSafe() {
  const m = await import("../mm-swap.mjs");
  try {
    return await m.quoteImpactPct({ venue, cls, tokenMeta: meta, chainKey: "robinhood", side: "sell", usdSize: 5, priceUsd: snap.priceUsd, quoteUsd: snap.quoteUsd });
  } catch (e) { return "ERR: " + e.message.slice(0, 120); }
}
console.log("impact ($5 sell):", impact);

// engine decision on the real strategy row
const s = getMmStrategy(process.argv[2] ?? "df7f0f54");
if (s) {
  const config = normalizeMmConfig(s);
  const decision = await decideTrade({ config, snapshot: snap, strategy: s }).catch((e) => "ERR: " + e.message.slice(0, 150));
  console.log("engine decision:", typeof decision === "string" ? decision : JSON.stringify(decision).slice(0, 200));
}
