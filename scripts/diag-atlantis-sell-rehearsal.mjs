/**
 * diag-atlantis-sell-rehearsal.mjs — read-only rehearsal of the ATLANTIS sell
 * routing: resolve the saved poolId on-chain (no Dexscreener), check which
 * branch it takes (LONG vs V4 vs V3), and dry-run the leg-1 spot-price math
 * that executeLongSell depends on. Sends NO transactions.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { resolvePoolOverride, getErc20Balance } = await import("../dip-swap.mjs");
const { getChain, httpClient } = await import("../chains.mjs");
const { isLongVenue, findLongVenue } = await import("../long-platform.mjs");

const TOKEN = "0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18"; // ATLANTIS
const SAVED = "0xac3ed4bca616d07d9b5771a88e05f698eb66fe4be7764ff3cffb1674af0bc039";
const CHAIN = "robinhood";

console.log("1) Dexscreener-based findLongVenue:");
const viaDs = await findLongVenue(TOKEN, CHAIN).catch((e) => { console.log("   ERR:", e.message.slice(0, 100)); return null; });
console.log("   →", viaDs ? "LONG venue found" : "null (Dexscreener likely rate-limited)");

console.log("2) Saved-poolId resolution (resolvePoolOverride):");
const resolved = await resolvePoolOverride(TOKEN, SAVED, CHAIN).catch((e) => { console.log("   ERR:", e.message.slice(0, 200)); return null; });
if (!resolved) { console.log("   → null"); process.exit(0); }
console.log(`   kind=${resolved.kind} fee=${resolved.fee} ts=${resolved.tickSpacing} hooks=${resolved.hooks}`);

console.log("3) isLongVenue(resolved):", isLongVenue(resolved));

if (resolved.kind === "v4") {
  console.log("4) spot price from StateView slot0 (leg-1 pricing input):");
  const dep = getChain(CHAIN);
  const [sqrtPriceX96] = await httpClient(CHAIN).readContract({
    address: dep.v4.stateView,
    abi: [{ name: "getSlot0", type: "function", stateMutability: "view", inputs: [{ type: "bytes32", name: "poolId" }], outputs: [{ type: "uint160", name: "sqrtPriceX96" }, { type: "int24", name: "tick" }, { type: "uint16", name: "protocolFee" }, { type: "uint16", name: "lpFee" }] }],
    functionName: "getSlot0",
    args: [resolved.poolId],
  }).catch((e) => { console.log("   ERR:", e.message.slice(0, 150)); return [0n]; });
  console.log("   sqrtPriceX96:", sqrtPriceX96.toString());
}
