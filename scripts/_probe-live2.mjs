// Why did the probe resolve quoteAsset=NATIVE for QUORUM (a USDG pool)?
// Trace the venue resolution.
import { resolveSellVenueForProbe } from "../sniper-extras.mjs";
const venue = await resolveSellVenueForProbe("0xa6452fd7134218f62056a304eaf501f8714a26b9", "robinhood", null).catch((e) => ({ error: e.message }));
console.log(JSON.stringify(venue, (k, v) => typeof v === "bigint" ? v.toString() : v, 1).slice(0, 700));
