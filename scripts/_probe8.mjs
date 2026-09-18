// Run getExternalFlow exactly as the watcher does.
import { resolveMmVenue, getMmSnapshot } from "../mm-swap.mjs";
import { getExternalFlow } from "../mm-watcher.mjs";
import { resolveMmSigner } from "../signer.mjs";
const signer = await resolveMmSigner("robinhood");
const { venue, cls, meta } = await resolveMmVenue("0x3b4a0048a00787a644932cd648faa043410c163e", "robinhood", null);
const snap = await getMmSnapshot(venue, cls, meta, "robinhood");
console.log("arg types: snap.quoteUsd=", typeof snap.quoteUsd, "signer.address=", typeof signer.address);
const t0 = Date.now();
const flow = await getExternalFlow("0x3b4a0048a00787a644932cd648faa043410c163e", "robinhood", venue, snap, signer, 2);
console.log("flow in", Date.now() - t0, "ms:", JSON.stringify(flow));
process.exit(0);
