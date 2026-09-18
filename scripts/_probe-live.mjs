// Direct probe (no HTTP timeout): the corrected quote-asset sell-probe on QUORUM.
import { readFileSync } from "fs";
const env = Object.fromEntries(readFileSync("/Users/lancepitman/accumulate/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.match(/^([^#=][^=]*)=(.*)$/)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;
const { probeSellDeliverability } = await import("../sell-probe.mjs");
const { resolveSigner } = await import("../signer.mjs");
const signer = await resolveSigner("robinhood");
const probe = await probeSellDeliverability({
  signer, chainKey: "robinhood",
  tokenAddress: "0xa6452fd7134218f62056a304eaf501f8714a26b9",
  amountHuman: 7000,
});
console.log(JSON.stringify(probe, (k, v) => typeof v === "bigint" ? v.toString() : v, 2));
process.exit(0);
