/**
 * diag-imd-missing.mjs — the user reports ~26 IMD missing. Find EVERY IMD transfer
 * from their EOA in the last 6000 blocks with resilient RPC. Read-only.
 */
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync("/Users/lancepitman/accumulate-imd/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const url = `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
const EOA = "a71fb297aa443adfc22ff74981d8c067ec3475cb";
const IMDTOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const IMD = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const txt = await res.text();
      if (!txt) { await sleep(400); continue; }
      return JSON.parse(txt);
    } catch { await sleep(700); }
  }
  return {};
}

const head = await rpc("eth_blockNumber", []);
const latest = parseInt(head.result, 16);
console.log("latest block", latest);
const found = [];
for (let s = latest - 6000; s < latest && found.length < 20; s += 10) {
  const j = await rpc("eth_getLogs", [{
    fromBlock: "0x" + s.toString(16), toBlock: "0x" + (s + 9).toString(16),
    address: IMD, topics: [IMDTOPIC, "0x000000000000000000000000" + EOA],
  }]);
  if (j.result) for (const l of j.result) found.push(l);
}
console.log("IMD transfers FROM EOA, last 6000 blocks:", found.length);
for (const l of found) {
  const t = await rpc("eth_getTransactionByHash", [l.transactionHash]);
  const rc = await rpc("eth_getTransactionReceipt", [l.transactionHash]);
  const amount = Number(BigInt(l.data)) / 1e18;
  console.log(`block ${parseInt(l.blockNumber, 16)} | ${amount} IMD | to ${t.result?.to} | status ${rc.result ? parseInt(rc.result.status) : "pending"}`);
  console.log(`   ${l.transactionHash}`);
}
