// Direct: compare venue resolution with the watcher's saved override vs auto.
import { resolveSellVenueForProbe } from "../sniper-extras.mjs";
const Q = "0xa6452fd7134218f62056a304eaf501f8714a26b9";
// watcher's override from DB (queried manually): placeholder replaced below
const OVERRIDE = process.argv[2]; // pass pool_address or "auto"
const override = OVERRIDE === "auto" ? null : OVERRIDE;
const v = await resolveSellVenueForProbe(Q, "robinhood", override).catch((e) => ({ error: e.message }));
console.log(JSON.stringify(v, (k, x) => typeof x === "bigint" ? x.toString() : x).slice(0, 500));
process.exit(0);
