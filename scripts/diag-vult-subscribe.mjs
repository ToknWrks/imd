// Reproduce subscribe()'s venue selection for VULT to see why the WETH pool
// wins. Read-only.
const { readFileSync } = await import("fs");
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { findBestPool, findBestV4Pool, findBestAerodromePool, findBestV3DollarPool, isDollarQuotedV3 } = await import("../dip-swap.mjs");

const VULT = "0xb788144DF611029C60b859DF47e79B7726C4DEBa";
const v4Pool = await findBestV4Pool(VULT, "ethereum").catch((e) => null);
const v3Pool = await findBestPool(VULT, "ethereum").catch((e) => ({ err: e.message.slice(0, 80) }));
const aeroPool = await findBestAerodromePool(VULT, "ethereum").catch(() => null);
const v3DollarPool = await findBestV3DollarPool(VULT, "ethereum").catch((e) => ({ err: e.message.slice(0, 80) }));

console.log("v4Pool:", v4Pool ? `${v4Pool.poolId.slice(0, 14)} liqUsd=${v4Pool.liquidityUsd}` : "none");
console.log("v3Pool:", v3Pool.err ? `ERR ${v3Pool.err}` : `${v3Pool.address} liq=${v3Pool.liquidity} (${typeof v3Pool.liquidity})`);
console.log("v3PoolLive:", v3Pool?.liquidity > 0n ? "yes" : "no (zero liquidity)");
console.log("aeroPool:", aeroPool ?? "none");
console.log("v3DollarPool:", v3DollarPool ?? "none");
