// Recheck the ORIGINAL 57.6k exit: internal ETH to wallet in that block?
import { readFileSync } from "fs";
import { createPublicClient, http, defineChain } from "viem";
const env = Object.fromEntries(readFileSync("/Users/lancepitman/accumulate/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.match(/^([^#=][^=]*)=(.*)$/)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
const robinhood = defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const EXIT = "0xb33ea908ab5501b900bed476c67a0cce16b79e111b158b194b6640950ae9c594";
const rcpt = await c.getTransactionReceipt({ hash: EXIT });
const blockHex = "0x" + BigInt(rcpt.blockNumber).toString(16);
const W = "0xa71fb297aa443adfc22ff74981d8c067ec3475cb";
const url = `https://robinhood-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ fromBlock: blockHex, toBlock: blockHex, category: ["internal"], toAddress: W, withMetadata: false, maxCount: "0x64" }] }) });
const b = (await res.json()).result?.transfers ?? [];
console.log("internal ETH transfers to wallet in exit block:", b.length, JSON.stringify(b.map((t) => ({ v: t.value, from: String(t.from).slice(0, 10) }))));
process.exit(0);
