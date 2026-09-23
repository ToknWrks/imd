/**
 * diag-usdc-flows.mjs — trace the user's USDC in/out over the last 6000 blocks
 * to explain where the 147 USDC from the 25-IMD sell went. Read-only.
 */
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync("/Users/lancepitman/accumulate-imd/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const url = `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
const EOA = "a71fb297aa443adfc22ff74981d8c067ec3475cb";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
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

async function scan(topics, label) {
  const found = [];
  for (let s = latest - 6000; s < latest && found.length < 20; s += 10) {
    const j = await rpc("eth_getLogs", [{
      fromBlock: "0x" + s.toString(16), toBlock: "0x" + (s + 9).toString(16),
      address: USDC, topics,
    }]);
    if (j.result) for (const l of j.result) found.push(l);
  }
  console.log(`${label}: ${found.length}`);
  for (const l of found.slice(-6)) {
    console.log(`  block ${parseInt(l.blockNumber, 16)} | ${Number(BigInt(l.data)) / 1e6} USDC | ${l.transactionHash.slice(0, 24)}…`);
  }
}

await scan([TOPIC, null, "0x000000000000000000000000" + EOA.slice(2)], "USDC TO EOA");
await scan([TOPIC, "0x000000000000000000000000" + EOA.slice(2)], "USDC FROM EOA");

const bal = await rpc("eth_call", [{ to: USDC, data: "0x70a08231000000000000000000000000" + EOA.slice(2) }, "latest"]);
console.log("USDC balance now:", Number(BigInt(bal.result)) / 1e6);
