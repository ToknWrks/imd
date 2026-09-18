// Concurrent getLogs works fine on the unbatched client — so the watcher's
// failure must come from something else in its process. Diff test: same call
// but INSIDE the watcher process (import mm-watcher, which boots loop()).
// Watch what the daemon's OWN ticks log while our direct calls succeed.
process.env.MM_WATCHER_DISABLE_LOOP = "1";
const mod = await import("../mm-watcher.mjs");
const { resolveMmVenue, getMmSnapshot } = await import("../mm-swap.mjs");
import { resolveMmSigner } from "../signer.mjs";
const signer = await resolveMmSigner("robinhood");
const { getExternalFlow } = mod;
const { venue, cls, meta } = await resolveMmVenue("0x3b4a0048a00787a644932cd648faa043410c163e", "robinhood", null);
const snap = await getMmSnapshot(venue, cls, meta, "robinhood");
console.log("calling getExternalFlow directly in watcher's process...");
const flow = await getExternalFlow("0x3b4a0048a00787a644932cd648faa043410c163e", "robinhood", venue, snap, signer, 2);
console.log("DIRECT RESULT:", JSON.stringify(flow));
setTimeout(() => process.exit(0), 200);
