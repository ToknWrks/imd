/**
 * diag-token-provenance.mjs — identify the launcher/platform of a token by
 * examining its venues (hooks identify platforms like long.xyz), Dexscreener
 * metadata, and pool structure. Read-only.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

for (const line of readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const TOKEN = process.argv[2] ?? "0x8f6bac9996dd9d9b887f7f282c4cf257b0961e22";
const { getChain } = await import("../chains.mjs");
const dip = await import("../dip-swap.mjs");
const { createPublicClient, http, parseAbi } = await import("viem");
const dep = getChain("robinhood");
const c = createPublicClient({ transport: http(dep.httpRpc()) });

// 1) token metadata
try {
  const meta = await dip.getTokenMeta(TOKEN, "robinhood");
  console.log("token:", meta.symbol, "| decimals:", meta.decimals);
} catch (e) { console.log("meta ERR:", e.message.slice(0, 100)); }

// 2) Dexscreener: pairs, dexId, labels, creation info
try {
  const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/${dep.dexscreener}/${TOKEN}`);
  const pairs = await res.json();
  console.log(`\nDexscreener: ${pairs.length} pair(s)`);
  for (const p of pairs.slice(0, 4)) {
    console.log(`  ${p.dexId}${(p.labels ?? []).length ? " [" + p.labels.join(",") + "]" : ""} | pair ${p.pairAddress?.slice(0, 14)}… | base ${p.baseToken?.symbol}/${p.quoteToken?.symbol} | liq $${Math.round(p.liquidity?.usd ?? 0)} | price $${p.priceUsd}`);
    if (p.info?.imageUrl) console.log("    has image:", p.info.imageUrl?.slice(0, 60));
    if (p.url) console.log("    url:", p.url);
  }
} catch (e) { console.log("dexscreener ERR:", e.message.slice(0, 100)); }

// 3) V4 pool(s) + hooks
try {
  const v4 = await dip.findBestV4Pool(TOKEN, "robinhood");
  if (v4) {
    const hook = v4.poolKey.hooks;
    const ZERO = "0x0000000000000000000000000000000000000000";
    console.log(`\nbest V4 pool: fee=${v4.fee} ts=${v4.tickSpacing} liqUsd=${Math.round(v4.liquidityUsd)}`);
    console.log(`  currency0: ${v4.poolKey.currency0}`);
    console.log(`  currency1: ${v4.poolKey.currency1}`);
    console.log(`  hook: ${v4.poolKey.hooks}${v4.poolKey.hooks === ZERO ? " (unhooked)" : ""}`);
    if (v4.poolKey.hooks.toLowerCase() === "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544") console.log("  → LONG platform (long.xyz) hook MATCH");
    // check the hook contract's code size + try a name
    if (v4.poolKey.hooks !== ZERO) {
      const code = await c.getBytecode({ address: v4.poolKey.hooks });
      console.log(`  hook code size: ${(code?.length ?? 2 - 2) / 2} bytes`);
    }
  } else console.log("\nno V4 pool found");
} catch (e) { console.log("v4 ERR:", e.message.slice(0, 100)); }

// 4) V3 pools
try {
  const v3 = await dip.findBestV3DollarPool(TOKEN, "robinhood");
  console.log("V3 dollar pool:", v3 ? `fee=${v3.fee} ${v3.address}` : "none");
} catch {}
