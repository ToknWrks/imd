// Verify findBestAerodromePool against LAPTOP (expect the USDC/LAPTOP
// Slipstream pool 0x99cf…, fee 20000/tickSpacing 200, ~$1.6M liq).
const { readFileSync } = await import("fs");
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { findBestAerodromePool } = await import("../dip-swap.mjs");

const LAPTOP = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const pool = await findBestAerodromePool(LAPTOP, "base");
console.log(JSON.stringify(pool, (k, v) => (typeof v === "bigint" ? String(v) : v), 2));
