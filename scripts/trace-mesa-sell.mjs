/** What did the MESA sell tx actually deliver to the wallet? (read-only) */
import { createPublicClient, http, formatEther } from "viem";
const c = createPublicClient({ transport: http("https://robinhood-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMY_API_KEY) });
const TX = "0xce60473156498a3361647e867d927b8ff097b55b0b333eb78aaff40932751e4a";
const wallet = "0xa71fb297aa443adfc22ff74981d8c067ec3475cb";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const r = await c.getTransactionReceipt({ hash: TX });
console.log("status:", r.status, "| logs:", r.logs.length);
for (const log of r.logs) {
  if (log.topics[0] !== TRANSFER) { console.log("  non-transfer log from", log.address.slice(0, 12)); continue; }
  const from = "0x" + log.topics[1].slice(26), to = "0x" + log.topics[2].slice(26);
  const sym = log.address.toLowerCase() === WETH ? "WETH" : "tok@" + log.address.slice(0, 8);
  const val = BigInt(log.data) / 10n ** 18n;
  const valStr = Number(val) < 0.000001 ? (BigInt(log.data)).toString() + " raw" : String(val);
  console.log(`  ${sym}: ${valStr}  ${from.slice(0, 10)}… → ${to.slice(0, 10)}…${to.toLowerCase() === wallet ? "  ← WALLET" : ""}`);
}
// native ETH via internal transfers
const res = await fetch("https://robinhood-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMY_API_KEY, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ fromBlock: "0x0", toBlock: "latest", category: ["internal"], toAddress: wallet, maxCount: "0x100", order: "desc" }] }),
});
const j = await res.json();
const hits = (j.result?.transfers || []).filter((t) => t.hash === TX);
console.log("internal native-ETH transfers to wallet in this tx:", hits.length);
for (const h of hits) console.log("  ", h.value, h.asset, "→", (h.to ?? "").slice(0, 12));
