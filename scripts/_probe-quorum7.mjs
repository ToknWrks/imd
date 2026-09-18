// NOTHING arrived at the main wallet in the exit block. So where did the
// proceeds go? Check: did this tx deliver to a DIFFERENT wallet (MM wallet?
// fee? the swap output token)? Reconstruct from the receipt's 3 logs:
// log2 is an unknown-token event (0xe5e7…) with topic[1]=poolId — maybe a
// "Swap" from a hooked pool delivering to the POOL, not the wallet.
// Fetch ALL txs in that block touching the wallet via block scan is heavy;
// instead: re-execute the exit mentally — executeSniperSell chose which venue?
// Re-check QUORUM's venue by running the same resolution read-only.
import { resolveSellVenue } from "../sniper-extras.mjs";
import { getChain } from "../chains.mjs";
const QUORUM = "0xa6452fd7134218f62056a304eaf501f8714a26b9";
const venue = await resolveSellVenue(QUORUM, "robinhood", null).catch((e) => ({ error: e.message }));
console.log("resolved sell venue now:", JSON.stringify(venue, (k, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 600));
process.exit(0);
