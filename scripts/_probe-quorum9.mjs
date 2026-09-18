// Run computeWalletPosition directly (read-only) and print every field.
import { readFileSync } from "fs";
// .env first (mm-watcher-style loader)
try {
  const env = Object.fromEntries(
    readFileSync("/Users/lancepitman/accumulate/.env", "utf8").split("\n")
      .map((l) => l.match(/^([^#=][^=]*)=(.*)$/)).filter(Boolean)
      .map((m) => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
  for (const [k, v] of Object.entries(env)) process.env[k] ??= v;
} catch {}
const { computeWalletPosition } = await import("../wallet-position.mjs");
const { getDipWatcher } = await import("../db.mjs");
const w = getDipWatcher("56277e4d-f074-4f71-97df-5b1f3d8242a3"); // QUORUM
const pos = await computeWalletPosition({
  contractAddress: w.contract_address,
  decimals: w.decimals ?? 18,
  walletAddress: "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb",
  chainKey: w.chain || "robinhood",
  poolOverride: w.pool_address ?? null,
});
console.log(JSON.stringify(pos, (k, v) => typeof v === "bigint" ? v.toString() : v, 2));
process.exit(0);
