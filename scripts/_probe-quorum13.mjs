// Did the probe sell's USDG actually reach the wallet? Check the receipt's
// USDG transfers. (The probe said DELIVERED based on native ETH delta, but
// QUORUM's pool quote is USDG — the native-delta heuristic may misclassify.)
import { readFileSync } from "fs";
import { createPublicClient, http, defineChain } from "viem";
const env = Object.fromEntries(readFileSync("/Users/lancepitman/accumulate/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.match(/^([^#=][^=]*)=(.*)$/)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
const robinhood = defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const HASH = "0xb7aaee0bfb9fcfa284a34a7d11453b448cb78aefa76bbedcbab8fb67e6b5b8db";
const W = "0xa71fb297aa443adfc22ff74981d8c067ec3475cb";
const rcpt = await c.getTransactionReceipt({ hash: HASH });
console.log("logs:", rcpt.logs.length);
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
for (const log of rcpt.logs) {
  if (log.address.toLowerCase() === USDG) {
    const from = "0x" + log.topics[1].slice(26);
    const to = "0x" + log.topics[2].slice(26);
    console.log("USDG:", Number(log.data) / 1e6, "USDG", from.slice(0, 10), "→", to.slice(0, 10), to === W ? "← WALLET ✓" : "");
  } else if (log.topics[0]?.startsWith("0x40e9cecb") || log.topics[0]?.startsWith("0xc532c43b")) {
    console.log("pool event from", log.address.slice(0, 12));
  } else {
    console.log("other log from", log.address.slice(0, 12), log.topics[0].slice(0, 14));
  }
}
process.exit(0);
