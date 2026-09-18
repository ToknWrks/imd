#!/usr/bin/env node
// scan-v4-pool.mjs — scan PoolManager Swap events for a V4 poolId.
// Usage: node scan-v4-pool.mjs [poolId] [blocksBack]
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const ALCHEMY = `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const POOL_ID = process.argv[2] ?? "0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3";
const BLOCKS_BACK = Number(process.argv[3] ?? 2000);
// Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, ...)
const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(ALCHEMY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    let j;
    try { j = await res.json(); } catch { await sleep(1200); continue; }
    if (j.error) {
      if (res.status === 429 || j.error.code === -32005) { await sleep(1500 * (i + 1)); continue; }
      throw new Error(`${method}: ${j.error.message}`);
    }
    return j.result;
  }
  throw new Error(`${method}: exhausted retries`);
}

const ethUsd = Number((await rpc("eth_call", [{ to: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", data: "0xfeaf968c" }, "latest"]).then((r) => BigInt(r))) ) / 1e8;
const latest = Number(await rpc("eth_blockNumber", []));
console.log(`ETH/USD: ${ethUsd.toFixed(2)} | latest block: ${latest} — scanning ${BLOCKS_BACK} blocks for poolId ${POOL_ID.slice(0, 14)}…`);

// topic1 = poolId (padded to 32 bytes)
const topic1 = POOL_ID;
const swaps = [];
let failed = 0;
for (let end = latest; end > latest - BLOCKS_BACK; end -= 10) {
  const from = "0x" + (end - 9).toString(16);
  const to = "0x" + end.toString(16);
  try {
    const logs = await rpc("eth_getLogs", [{ address: POOL_MANAGER, topics: [SWAP_TOPIC, topic1], fromBlock: from, toBlock: to }]);
    for (const log of logs) {
      // data: [sqrtPriceX96 uint160][liquidity uint128][tick int24][fee uint24] padded
      // int128 amounts are in data too? No — amount0/amount1 are NON-indexed → in data
      // data layout: amount0 int128, amount1 int128, sqrtPriceX96, liquidity, tick, fee
      const a0 = BigInt("0x" + log.data.slice(2, 66));
      const s0 = a0 >= 2n ** 255n ? a0 - 2n ** 256n : a0;
      const a1 = BigInt("0x" + log.data.slice(66, 130));
      const s1 = a1 >= 2n ** 255n ? a1 - 2n ** 256n : a1;
      swaps.push({ block: Number(log.blockNumber), tx: log.transactionHash, amount0: s0, amount1: s1 });
    }
  } catch (e) {
    failed++;
    if (failed <= 3) console.error("chunk failed:", e.message.slice(0, 120));
  }
  await sleep(140);
}
console.log(`chunks failed: ${failed}, V4 swaps found: ${swaps.length}`);
swaps.sort((a, b) => a.block - b.block);
let triggered = 0;
for (const s of swaps.slice(-25).reverse()) {
  // currency0 = ETH, currency1 = IMD. ETH-in/token-out = SELL (amount0 > 0, amount1 < 0)
  const isSell = s.amount0 > 0n && s.amount1 < 0n;
  const ethMoved = Number(isSell ? s.amount0 : -s.amount0) / 1e18;
  const usd = ethMoved * ethUsd;
  const hit = isSell && usd >= 5000 ? "🚨 TRIGGER" : "";
  if (hit) triggered++;
  console.log(`blk ${s.block} ${isSell ? "SELL" : "BUY "} eth=${ethMoved.toFixed(4)} ($${usd.toFixed(0)}) ${hit}\n     tx ${s.tx}`);
}
console.log(`\n${triggered} swaps crossed the $5,000 sell threshold`);
