/**
 * fetch-ui-sell-tx.mjs — narrow the block scan to the found transfer and dump the
 * full tx calldata to /tmp/ui-sell-tx.json. Read-only.
 */
import { readFileSync, writeFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync("/Users/lancepitman/accumulate-imd/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const IMDTOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const EOA = "a71fb297aa443adfc22ff74981d8c067ec3475cb";
const url = `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const txt = await res.text();
      if (!txt) { await sleep(400); continue; }
      return JSON.parse(txt);
    } catch { await sleep(600); }
  }
  return {};
}

for (let start = 26010330; start < 26018330; start += 10) {
  const j = await rpc("eth_getLogs", [{
    fromBlock: "0x" + start.toString(16), toBlock: "0x" + (start + 9).toString(16),
    address: "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
    topics: [IMDTOPIC, "0x000000000000000000000000" + EOA],
  }]);
  if (j.result && j.result.length) {
    const l = j.result[0];
    console.log("FOUND at block", parseInt(l.blockNumber, 16), "hash", l.transactionHash);
    const t = await rpc("eth_getTransactionByHash", [l.transactionHash]);
    const tx = t.result;
    console.log("to:", tx.to);
    console.log("value wei:", BigInt(tx.value).toString());
    console.log("input bytes:", (tx.input.length - 2) / 2);
    writeFileSync("/tmp/ui-sell-tx.json", JSON.stringify({ hash: l.transactionHash, to: tx.to, input: tx.input }, null, 2));
    console.log("saved to /tmp/ui-sell-tx.json");
    break;
  }
}
