/**
 * diag-final-state.mjs — full wallet state for the confused-sell diagnosis:
 * ETH balance, nonce, IMD/USDC balances, and the missing "1 IMD today" tx.
 * Read-only, resilient RPC.
 */
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync("/Users/lancepitman/accumulate-imd/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const url = `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
const EOA = "0xa71fb297aa443adfc22ff74981d8c067ec3475cb";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const txt = await res.text();
      if (!txt) { await sleep(500); continue; }
      const j = JSON.parse(txt);
      if (j.error) { console.error("rpc error:", JSON.stringify(j.error).slice(0, 120)); return {}; }
      return j;
    } catch { await sleep(700); }
  }
  return {};
}

const eth = await rpc("eth_getBalance", [EOA, "latest"]);
if (eth.result) console.log("ETH balance:", Number(BigInt(eth.result)) / 1e18);
const n = await rpc("eth_getTransactionCount", [EOA, "latest"]);
if (n.result) console.log("EOA tx count (nonce):", parseInt(n.result, 16));

// find today's tx(s): scan the last 500 blocks for ANY log where the EOA appears
// in topic1 OR topic2 (from/to), across IMD + the hook-router + pool manager
const IMD = "0xd34a99bc0f67e1bbd63c660e6d0b0dd03e263b7".toLowerCase();
const IMD_REAL = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const head = await rpc("eth_blockNumber", []);
const latest = parseInt(head.result, 16);

// Transfers TO the EOA from IMD's pool events (a successful ETH-out sell sends
// nothing to the EOA via Transfer — ETH is unwrapped — but the SWAP event fires
// on the pool; simpler: get every tx hash in recent blocks from the EOA via
// eth_getLogs on the PoolManager with any topic).
const PM = "0x000000000004444c5dc75cb358380d2e3dE08A90";
const found = [];
for (let s = latest - 500; s < latest && found.length < 10; s += 10) {
  const j = await rpc("eth_getLogs", [{
    fromBlock: "0x" + s.toString(16), toBlock: "0x" + (s + 9).toString(16),
    address: PM,
  }]);
  if (j.result) {
    for (const l of j.result) {
      // check if any topic contains the EOA
      if (l.topics.some((t) => t && t.slice(26).toLowerCase() === EOA.slice(2).toLowerCase())) found.push(l);
    }
  }
}
console.log("PoolManager logs mentioning EOA (last 500 blocks):", found.length);
for (const l of found.slice(-6)) {
  console.log(`  block ${parseInt(l.blockNumber, 16)} | tx ${l.transactionHash}`);
  const t = await rpc("eth_getTransactionByHash", [l.transactionHash]);
  if (t.result) console.log(`    from ${t.result.from} to ${t.result.to}`);
}
