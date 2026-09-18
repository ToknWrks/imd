/**
 * diag-mm-atlantis-pricing.mjs — trace every intermediate in the ATLANTIS
 * MM snapshot to find which number is wrong: quotePerToken (slot0), the raw
 * s² ratio, MU's USD price via each fallback tier, and the final priceUsd
 * vs the user's real fill prices.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

for (const line of readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const mm = await import("../mm-swap.mjs");
const dip = await import("../dip-swap.mjs");
const { getChain } = await import("../chains.mjs");
const { createPublicClient, http, parseAbi } = await import("viem");

const dep = getChain("robinhood");
const ATL = "0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18";
const MU = "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD";
const POOL_ID = "0xac3ed4bca616d07d9b5771a88e05f698eb66fe4be7764ff3cffb1674af0bc039";

// 1) venue + classification
const { venue, meta, cls } = await mm.resolveMmVenue(ATL, "robinhood", null);
console.log(`pool: fee=${venue.poolKey.fee} ts=${venue.poolKey.tickSpacing} hooks=${venue.poolKey.hooks.slice(0, 10)}`);
console.log(`cls: tokenIs0=${cls.tokenIs0} kind=${cls.kind} quote=${cls.quote}`);

// 2) raw slot0 → s²
const c = createPublicClient({ transport: http(dep.httpRpc()) });
const SV = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"]);
const s0 = await c.readContract({ address: dep.v4.stateView, abi: SV, functionName: "getSlot0", args: [POOL_ID] });
const s = Number(s0[0]) / 2 ** 96;
console.log(`s² (raw MU per raw ATL): ${(s * s).toExponential(6)}  → whole-unit MU-per-ATL: ${(s * s).toExponential(6)}`);

// 3) snapshot as the daemon computes it
const snap = await mm.getMmSnapshot(venue, cls, meta, "robinhood");
console.log(`\nsnapshot: priceUsd=${snap.priceUsd} quoteUsd=${snap.quoteUsd} quoteSymbol=${snap.quoteSymbol} liqUsd=${Math.round(snap.liquidityUsd ?? 0)}`);

// 4) MU's USD price through each tier manually
console.log("\n--- MU USD price tiers ---");
// tier 1: V4 pool for MU
try {
  const qVenue = await dip.findBestV4Pool(MU, "robinhood");
  console.log("tier1 findBestV4Pool(MU):", qVenue ? `fee=${qVenue.fee} currency0=${qVenue.poolKey.currency0.slice(0, 10)} currency1=${qVenue.poolKey.currency1.slice(0, 10)}` : "null");
} catch (e) { console.log("tier1 ERR:", e.message.slice(0, 100)); }
// tier 2: V3 dollar pool for MU
try {
  const v3 = await dip.findBestV3DollarPool(MU, "robinhood");
  console.log("tier2 findBestV3DollarPool(MU):", v3 ? `fee=${v3.fee} token0=${v3.token0.slice(0, 10)} token1=${v3.token1.slice(0, 10)} liqUsd=${Math.round(v3.liquidityUsd)}` : "null");
  if (v3) {
    const tokenIs0 = v3.token0.toLowerCase() === MU.toLowerCase();
    const p = await dip.getV3DollarSpotPriceUsd({ poolAddress: v3.address, tokenIs0, tokenDecimals: 18, chainKey: "robinhood" });
    console.log("  MU/USDG spot:", p);
  }
} catch (e) { console.log("tier2 ERR:", e.message.slice(0, 100)); }
// tier 3: Dexscreener
try {
  const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/${dep.dexscreener}/${MU}`);
  const pairs = await res.json();
  for (const pair of (pairs ?? []).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)).slice(0, 3)) {
    const base = pair?.baseToken?.address?.toLowerCase();
    const q = pair?.quoteToken?.address?.toLowerCase();
    const usd = Number(pair?.priceUsd ?? 0);
    const native = Number(pair?.priceNative ?? 0);
    console.log(`  pair base=${base?.slice(0, 10)} quote=${q?.slice(0, 10)} priceUsd=${usd} priceNative=${native.toPrecision?.(6) ?? native} → derived=${q === MU.toLowerCase() && native > 0 ? (usd / native).toPrecision(6) : base === MU.toLowerCase() ? usd : "n/a"}`);
  }
} catch (e) { console.log("tier3 ERR:", e.message.slice(0, 100)); }

// 5) ground truth from the user's fills
console.log("\n--- ground truth from fills ---");
console.log("sell: 1,120,274 ATL → 0.0212 MU → 1 ATL ≈ 1.893e-8 MU");
console.log("buy:  2,102,909 ATL ← 0.0474 MU → 1 ATL ≈ 2.254e-8 MU");
