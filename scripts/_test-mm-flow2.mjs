// Re-test all four strategies' flow scans AFTER the unbatched-client fix.
// NOTE: importing mm-watcher starts its own daemon loop — that's fine, we let
// it run a few real ticks and inspect the output.
import { resolveMmSigner } from "../signer.mjs";
process.exitCode = 0;
const { getExternalFlow } = await import("../mm-watcher.mjs");
const { resolveMmVenue, getMmSnapshot } = await import("../mm-swap.mjs");
const signer = await resolveMmSigner("robinhood");
const TOKENS = [
  ["SIRIUS", "0x3b4a0048a00787a644932cd648faa043410c163e"],
  ["ATLANTIS", "0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18"],
  ["IF", "0x232CDFc415D10b673845D83Dc02ba2eaBe7e30d1"],
  ["KERMIT", "0xd111d37ba471fbe1c038976c8c51560bb0ee2335"],
];
let fail = 0;
for (const [sym, addr] of TOKENS) {
  try {
    const { venue, cls, meta } = await resolveMmVenue(addr, "robinhood", null);
    const snap = await getMmSnapshot(venue, cls, meta, "robinhood");
    const flow = await getExternalFlow(addr, "robinhood", venue, snap, signer, 2);
    console.log(`RESULT ${sym}: count=${flow.count} buys=$${Number(flow.buysUsd).toFixed(2)} sells=$${Number(flow.sellsUsd).toFixed(2)} net=$${Number(flow.netUsd).toFixed(2)} [${flow.source}]`);
    if (flow.source === "unavailable") fail++;
  } catch (e) { console.log(`RESULT ${sym}: ERROR ${e.message}`); fail++; }
}
console.log(fail ? "SOME FAILED" : "ALL SCANS OK");
setTimeout(() => process.exit(fail ? 1 : 0), 100);
