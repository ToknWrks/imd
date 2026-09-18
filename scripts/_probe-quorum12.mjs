// Full hashes from the probe output: get tx values for the QUORUM buys/exit.
import { createPublicClient, http, defineChain } from "viem";
const robinhood = defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const hashes = [
  "0x5c0b357875b0", // buy 187k
  "0x41ce1380ff10", // buy 388k
  "0x5d0c88b4b387", // buy 234k
  "0xf436b3f58001", // buy 101k
  "0xb33ea908ab55", // EXIT 57k
  "0x1f1cec446e0b", // exit-ish 577k OUT
  "0xa226e13db469", // 168k OUT
];
const all = await c.request({ method: "eth_getBlockByNumber", params: ["latest", false] }).then(() => null).catch(() => null);
// need full hashes — refetch transfers for main wallet and match prefixes
const { readFileSync } = await import("fs");
const env = Object.fromEntries(readFileSync("/Users/lancepitman/accumulate/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.match(/^([^#=][^=]*)=(.*)$/)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
const url = `https://robinhood-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
const QUORUM = "0xa6452fd7134218f62056a304eaf501f8714a26b9";
const MAIN = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";
async function transfers(direction) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ fromBlock: "0x0", toBlock: "latest", category: ["erc20"], withMetadata: false, order: "asc", maxCount: "0x3e8", contractAddresses: [QUORUM], [direction === "in" ? "toAddress" : "fromAddress"]: MAIN }] }) });
  return (await res.json()).result.transfers ?? [];
}
const [ins, outs] = await Promise.all([transfers("in"), transfers("out")]);
for (const t of [...ins, ...outs]) {
  if (!hashes.some((p) => t.hash.startsWith(p.slice(2)))) continue;
  const tx = await c.getTransaction({ hash: t.hash });
  console.log((t.value >= 0 ? (ins.includes(t) ? "IN " : "OUT") : "?"), Number(t.value).toFixed(0), "QUORUM  txvalue:", (Number(tx.value) / 1e18).toFixed(6), "ETH  tx", t.hash.slice(0, 14));
}
process.exit(0);
