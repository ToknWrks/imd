/** Where did the MESA sale proceeds actually land? (read-only) */
import { createPublicClient, http, formatEther } from "viem";
const c = createPublicClient({ transport: http("https://robinhood-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMY_API_KEY) });
const TX = "0xce60473156498a3361647e867d927b8ff097b55b0b333eb78aaff40932751e4a";
const wallet = "0xa71fb297aa443adfc22ff74981d8c067ec3475cb";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const r = await c.getTransactionReceipt({ hash: TX });
console.log("logs:", r.logs.length);
for (const log of r.logs) {
  console.log("  addr:", log.address, "| topic0:", log.topics[0].slice(0, 18), "| data:", log.data.slice(0, 70));
}
// WETH + USDG balance changes around this tx — scan the wallet's recent WETH/USDG IN transfers
const res = await fetch("https://robinhood-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMY_API_KEY, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ fromBlock: "0x0", toBlock: "latest", category: ["erc20"], toAddress: wallet, contractAddresses: [WETH, USDG], maxCount: "0x20", order: "desc", withMetadata: true }] }),
});
const j = await res.json();
console.log("\nrecent WETH/USDG IN to wallet (top 8):");
for (const t of (j.result?.transfers || []).slice(0, 8)) {
  console.log("  ", t.metadata?.blockTimestamp?.slice(0, 16), t.asset, t.value, "| tx", t.hash.slice(0, 16), t.hash === TX ? "← SELL TX" : "");
}
