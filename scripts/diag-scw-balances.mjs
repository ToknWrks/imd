/**
 * diag-scw-balances.mjs — full balance picture across the EOA and its SCW.
 * Explains where the user's sell proceeds actually live. Read-only.
 */
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync("/Users/lancepitman/accumulate-imd/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const url = `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
const EOA = "a71fb297aa443adfc22ff74981d8c067ec3475cb";
const SCW = "7b63e112215b707bf72d5d6681fd2132d5cfeedb";
const IMD = "d34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
const USDC = "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
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

const balOf = async (token, owner) => {
  const j = await rpc("eth_call", [{ to: "0x" + token, data: "0x70a08231000000000000000000000000" + owner }, "latest"]);
  return j.result ? BigInt(j.result) : 0n;
};

for (const [name, owner] of [["EOA", EOA], ["SCW", SCW]]) {
  const eth = await rpc("eth_getBalance", ["0x" + owner, "latest"]);
  const imd = await balOf(IMD, owner);
  const usdc = await balOf(USDC, owner);
  console.log(`${name} (0x${owner.slice(0, 8)}…):`);
  console.log(`  ETH : ${eth.result ? Number(BigInt(eth.result)) / 1e18 : "?"}`);
  console.log(`  IMD : ${Number(imd) / 1e18}`);
  console.log(`  USDC: ${Number(usdc) / 1e6}`);
}

// USDC flows for the SCW — last 6000 blocks (single-block chunks w/ resilience)
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const head = await rpc("eth_blockNumber", []);
const latest = parseInt(head.result, 16);
const found = [];
for (let s = latest - 6000; s < latest && found.length < 12; s += 10) {
  const j = await rpc("eth_getLogs", [{
    fromBlock: "0x" + s.toString(16), toBlock: "0x" + (s + 9).toString(16),
    address: "0x" + USDC, topics: [TOPIC, null, "0x000000000000000000000000" + SCW],
  }]);
  if (j.result) for (const l of j.result) found.push(l);
}
console.log("\nUSDC transfers TO SCW (last 6000 blocks):", found.length);
for (const l of found.slice(-8)) {
  console.log(`  block ${parseInt(l.blockNumber, 16)} | ${Number(BigInt(l.data)) / 1e6} USDC | tx ${l.transactionHash}`);
}
