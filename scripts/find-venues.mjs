#!/usr/bin/env node
// find-venues.mjs — check Uniswap V2 pair + a Dexscreener lookup for every
// venue a token trades on, to see where big volume actually routes.
import { readFileSync } from "fs";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const TOKEN = process.argv[2] ?? "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
const ALCHEMY = `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

async function rpc(method, params) {
  const res = await fetch(ALCHEMY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// Uniswap V2 getPair(token, WETH) — best effort
try {
  const pairData = TOKEN.toLowerCase().replace(/^0x/, "") + WETH.toLowerCase().replace(/^0x/, "");
  const pair = await rpc("eth_call", [{ to: V2_FACTORY, data: "0xe6a43905" + pairData }, "latest"]);
  console.log("Uniswap V2 IMD/WETH pair:", "0x" + pair.slice(26));
} catch (e) {
  console.log("Uniswap V2 lookup failed:", e.message);
}

// Dexscreener: every venue this token trades on
const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/ethereum/${TOKEN}`);
const pairs = await res.json();
console.log("\nDexscreener venues (sorted by liquidity):");
const sorted = (pairs || []).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
for (const p of sorted.slice(0, 12)) {
  console.log(
    `- ${p.dexId} ${p.pairAddress} | liq $${Math.round(p.liquidity?.usd ?? 0).toLocaleString()} | vol24h $${Math.round(p.volume?.h24 ?? 0).toLocaleString()} | price $${p.priceUsd}`
  );
}
