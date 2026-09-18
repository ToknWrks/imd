#!/usr/bin/env node
// scan-pool.mjs — raw JSON-RPC eth_getLogs scan of a pool's Swap events.
// Usage: node scan-pool.mjs [poolAddress] [blocksBack]
import { readFileSync } from "fs";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const ALCHEMY = `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const POOL = process.argv[2] ?? "0xD6A822D028bbf7b6EDfA1533e110Ee40c08551d9";
const BLOCKS_BACK = Number(process.argv[3] ?? 2000);
const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

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

const latest = Number(await rpc("eth_blockNumber", []));
console.log(`latest block: ${latest} — scanning ${BLOCKS_BACK} blocks back in 10-block windows`);

const swaps = [];
let failed = 0;
for (let end = latest; end > latest - BLOCKS_BACK; end -= 10) {
  const from = "0x" + (end - 9).toString(16);
  const to = "0x" + end.toString(16);
  try {
    const logs = await rpc("eth_getLogs", [{ address: POOL, topics: [SWAP_TOPIC], fromBlock: from, toBlock: to }]);
    for (const log of logs) {
      const amount0 = BigInt("0x" + log.data.slice(2, 66));
      const signed0 = amount0 >= 2n ** 255n ? amount0 - 2n ** 256n : amount0;
      const amount1 = BigInt("0x" + log.data.slice(66, 130));
      const signed1 = amount1 >= 2n ** 255n ? amount1 - 2n ** 256n : amount1;
      swaps.push({ block: Number(log.blockNumber), tx: log.transactionHash, amount0: signed0, amount1: signed1 });
    }
  } catch (e) {
    failed++;
    if (failed <= 3) console.error("chunk failed:", e.message.slice(0, 120));
  }
  await sleep(140);
}
console.log(`chunks failed: ${failed}, swaps found: ${swaps.length}`);
swaps.sort((a, b) => a.block - b.block);
for (const s of swaps.slice(-20).reverse()) {
  // token0 is WETH for this pool
  const kind = s.amount0 < 0n
    ? `SELL ethOut=${(Number(-s.amount0) / 1e18).toFixed(4)} tokenIn=${(Number(s.amount1) / 1e18).toFixed(2)}`
    : `BUY  ethIn=${(Number(s.amount0) / 1e18).toFixed(4)} tokenOut=${(Number(-s.amount1) / 1e18).toFixed(2)}`;
  console.log(`blk ${s.block} ${kind}\n     tx ${s.tx}`);
}
