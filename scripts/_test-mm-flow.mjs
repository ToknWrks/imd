/** Read-only test of the Swap-log external-flow scanner (no trades, no DB writes). */
import { resolveMmVenue, getMmSnapshot, getQuoteTokenDecimals } from "../mm-swap.mjs";
import { getExternalFlow } from "../mm-watcher.mjs";
import { resolveMmSigner } from "../signer.mjs";

const TOKENS = [
  { symbol: "SIRIUS", address: "0x3b4a0048a00787a644932cd648faa043410c163e" },
  { symbol: "ATLANTIS", address: "0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18" },
  { symbol: "IF", address: "0x232CDFc415D10b673845D83Dc02ba2eaBe7e30d1" },
  { symbol: "KERMIT", address: "0xd111d37ba471fbe1c038976c8c51560bb0ee2335" },
];

const signer = await resolveMmSigner("robinhood");
let fail = 0;
for (const t of TOKENS) {
  try {
    const { venue, cls, meta } = await resolveMmVenue(t.address, "robinhood", null);
    const snap = await getMmSnapshot(venue, cls, meta, "robinhood");
    const flow = await getExternalFlow(t.address, "robinhood", venue, snap, signer, 2);
    console.log(`${t.symbol}: venue=${venue.kind} pool=${(venue.poolId ?? venue.address ?? "?").slice(0, 12)}… price=$${snap.priceUsd ? Number(snap.priceUsd).toPrecision(6) : 0} liq=$${snap.liquidityUsd} → flow count=${flow.count} buys=$${flow.buysUsd.toFixed(2)} sells=$${flow.sellsUsd.toFixed(2)} net=$${flow.netUsd.toFixed(2)} [${flow.source}]`);
  } catch (e) {
    console.error(`${t.symbol}: ERROR ${e.message}`);
    fail++;
  }
}
process.exit(fail ? 1 : 0);
