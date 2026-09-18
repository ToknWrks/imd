// What did the wallet actually receive for the QUORUM exit? Check token IN
// transfers in the same tx across ALL contracts (no filter), plus native ETH.
import { readFileSync } from "fs";
import { createPublicClient, http, defineChain } from "viem";
const env = Object.fromEntries(readFileSync("/Users/lancepitman/accumulate/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.match(/^([^#=][^=]*)=(.*)$/)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
const url = `https://robinhood-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
const W = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";
const HASH = "0xb33ea908ab5501b900bed476c67a0cce16b79e111b158b194b6640950ae9c594";
// native ETH received by the wallet in this tx?
const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [HASH] }) });
const r = (await res.json()).result;
// internal transfers: use alchemy_getAssetTransfers with category external/contract to the wallet in that block
const block = parseInt(r.blockNumber, 16);
const res2 = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ fromBlock: r.blockNumber, toBlock: r.blockNumber, category: ["external", "internal"], toAddress: W, withMetadata: false, maxCount: "0x64" }] }) });
const b2 = (await res2.json()).result?.transfers ?? [];
console.log("ETH/internal transfers to wallet in exit block:", JSON.stringify(b2.map((t) => ({ asset: t.asset, value: t.value, from: t.from?.slice(0, 10) })), null, 1));
// token-in for the wallet with NO contract filter (catch any payout token)
const res3 = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ fromBlock: r.blockNumber, toBlock: r.blockNumber, category: ["erc20"], toAddress: W, withMetadata: false, maxCount: "0x64" }] }) });
const b3 = (await res3.json()).result?.transfers ?? [];
console.log("ERC20 transfers to wallet in exit block:", JSON.stringify(b3.map((t) => ({ asset: t.asset, value: t.value, contract: t.rawContract?.address })), null, 1));
process.exit(0);
