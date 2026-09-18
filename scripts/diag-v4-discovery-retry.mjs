/**
 * diag-v4-discovery-retry.mjs — run findBestV4Pool for each Robinhood token
 * three times to separate Dexscreener flakiness from real resolution failures.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { findBestV4Pool } = await import("../dip-swap.mjs");

const tokens = [
  ["ATLANTIS", "0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18"],
  ["SIRIUS", "0x3b4a0048a00787a644932cd648faa043410c163e"],
  ["PINK", "0xbc9cc4b93a08b2dfba87067a9c53e713db3314ce"],
  ["IF", "0x232cdfc415d10b673845d83dc02ba2eabe7e30d1"],
];

for (const [sym, addr] of tokens) {
  const attempts = [];
  for (let i = 0; i < 3; i++) {
    try {
      const p = await findBestV4Pool(addr, "robinhood");
      attempts.push(p ? `OK fee=${p.fee} ts=${p.tickSpacing} hooked=${p.hooks.slice(0, 8)} liqUsd=${Math.round(p.liquidityUsd)}` : "null");
    } catch (e) { attempts.push(`ERR ${e.message.slice(0, 60)}`); }
    if (i < 2) await new Promise((r) => setTimeout(r, 1200));
  }
  console.log(`${sym}: ${attempts.join(" | ")}`);
}
