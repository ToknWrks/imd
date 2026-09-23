/**
 * diag-permit2-imd.mjs — the V4 sell's SETTLE pulls IMD via Permit2, so the Transfer
 * event's from-address is the PERMIT2 contract, not the EOA. Scan for those in the
 * last 1500 blocks to find the user's "1 IMD" sell. Read-only, resilient.
 */
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync("/Users/lancepitman/accumulate-imd/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const url = `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
const IMD = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PERMIT2 = "000000000022d473030f116ddee9f6b43ac78ba3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const txt = await res.text();
      if (!txt) { await sleep(500); continue; }
      return JSON.parse(txt);
    } catch { await sleep(800); }
  }
  return {};
}

const head = await rpc("eth_blockNumber", []);
const latest = parseInt(head.result, 16);
const found = [];
for (let s = latest - 1500; s < latest && found.length < 10; s += 10) {
  const j = await rpc("eth_getLogs", [{
    fromBlock: "0x" + s.toString(16), toBlock: "0x" + (s + 9).toString(16),
    address: IMD, topics: [TOPIC, "0x000000000000000000000000" + PERMIT2],
  }]);
  if (j.result) for (const l of j.result) found.push(l);
}
console.log("IMD transfers FROM Permit2 (last 1500 blocks):", found.length);
for (const l of found.slice(-8)) {
  const rc = await rpc("eth_getTransactionReceipt", [l.transactionHash]);
  const t = await rpc("eth_getTransactionByHash", [l.transactionHash]);
  console.log(`  block ${parseInt(l.blockNumber, 16)} | ${Number(BigInt(l.data)) / 1e18} IMD | tx-from ${t.result?.from} | status ${rc.result ? parseInt(rc.result.status) : "?"}`);
  console.log(`   ${l.transactionHash}`);
}
