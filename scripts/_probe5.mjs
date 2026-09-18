// The failing path must involve getQuoteTokenDecimals or the snap/signer args.
// Reproduce with the real watcher function:
import { resolveMmVenue, getMmSnapshot } from "../mm-swap.mjs";
import { getExternalFlow } from "../mm-watcher.mjs";
import { resolveMmSigner } from "../signer.mjs";
const signer = await resolveMmSigner("robinhood");
const { venue, cls, meta } = await resolveMmVenue("0x3b4a0048a00787a644932cd648faa043410c163e", "robinhood", null);
const snap = await getMmSnapshot(venue, cls, meta, "robinhood");
console.log("snap.quoteUsd:", snap.quoteUsd, "snap.ethUsd:", snap.ethUsd, "snap.liquidityUsd:", snap.liquidityUsd);
const flow = await getExternalFlow("0x3b4a0048a00787a644932cd648faa043410c163e", "robinhood", venue, snap, signer, 2);
console.log("flow:", JSON.stringify(flow));
