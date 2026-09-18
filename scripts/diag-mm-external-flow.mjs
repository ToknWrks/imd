/**
 * diag-mm-external-flow.mjs — replicate mm-watcher's getExternalFlow exactly
 * and print the raw Dexscreener response to find why the daemon reads 0.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

for (const line of readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { getChain } = await import("../chains.mjs");
const dep = getChain("robinhood");
const token = "0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18";

try {
  const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/${dep.dexscreener}/${token}`);
  console.log("HTTP status:", res.status);
  const pairs = await res.json();
  console.log("pairs returned:", pairs.length);
  const venuePoolId = "0xac3ed4bca616d07d9b5771a88e05f698eb66fe4be7764ff3cffb1674af0bc039";
  const match = (pairs ?? []).find((p) => (p.pairAddress ?? "").toLowerCase() === venuePoolId.toLowerCase())
    ?? (pairs ?? [])[0];
  console.log("matched pair:", match?.pairAddress?.slice(0, 14), "label:", match?.labels, "dexId:", match?.dexId);
  console.log("txns:", JSON.stringify(match?.txns));
} catch (e) {
  console.log("FETCH ERR:", e.message.slice(0, 200));
}
