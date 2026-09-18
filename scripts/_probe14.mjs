// Definitive localization: import the watcher's ACTUAL getExternalFlow but
// stub out everything around it — then bisect by calling it with progressively
// real args. Also dump e.stack for the real error instead of just e.message.
import * as watcher from "../mm-watcher.mjs";
import { resolveMmVenue, getMmSnapshot } from "../mm-swap.mjs";
import { resolveMmSigner } from "../signer.mjs";
const signer = await resolveMmSigner("robinhood");
const { venue, cls, meta } = await resolveMmVenue("0x3b4a0048a00787a644932cd648faa043410c163e", "robinhood", null);
const snap = await getMmSnapshot(venue, cls, meta, "robinhood");
// Monkey-patch console.log is already in place; instead capture the thrown
// error by re-implementing the catch: temporarily swap in an error-dumping
// version — but we can't patch internals. Instead: the catch prints e.message.
// Call it and ALSO independently verify the exact filter afterwards.
const flow = await watcher.getExternalFlow("0x3b4a0048a00787a644932cd648faa043410c163e", "robinhood", venue, snap, signer, 2);
console.log("WATCHER FN RESULT:", JSON.stringify(flow));
// Now the identical filter by hand:
import { getAnalysisClient } from "../chains.mjs";
import { keccak256, toHex } from "viem";
const c = getAnalysisClient("robinhood");
const TOPIC = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const latest = await c.getBlockNumber();
const logs = await c.getLogs({ address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", topics: [TOPIC, venue.poolId], fromBlock: latest - 900n, toBlock: latest });
console.log("SAME-FILTER HAND CALL OK:", logs.length);
setTimeout(() => process.exit(0), 200);
