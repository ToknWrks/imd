// End-to-end: resolvePoolOverride with the user's poolId 0x0bcfb8dd…, exactly
// as dip-watcher's subscribe() does. Read-only.
const { readFileSync } = await import("fs");
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { resolvePoolOverride } = await import("../dip-swap.mjs");

const LAPTOP = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const POOL = "0x0bcfb8ddc2af0bc61d72be1daf470c8853f568c4b04f619b0a31f1ced1216c4d";

try {
  const venue = await resolvePoolOverride(LAPTOP, POOL, "base");
  console.log("✓ override resolved:");
  console.log(JSON.stringify(venue, (k, v) => typeof v === "bigint" ? String(v) : v, 2));
} catch (e) {
  console.log("✗ STILL FAILING:", e.message);
}
