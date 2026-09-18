// The exit tx has only 3 logs and no USDG transfer to the wallet. Dump ALL
// logs raw to see what actually happened in that transaction.
import { readFileSync } from "fs";
import { createPublicClient, http, defineChain } from "viem";
const env = Object.fromEntries(readFileSync("/Users/lancepitman/accumulate/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.match(/^([^#=][^=]*)=(.*)$/)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
const robinhood = defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const HASH = "0xb33ea908ab5501b900bed476c67a0cce16b79e111b158b194b6640950ae9c594";
const rcpt = await c.getTransactionReceipt({ hash: HASH });
console.log("to:", rcpt.to, "from:", rcpt.from);
console.log("value:", rcpt.value?.toString?.() ?? rcpt.value);
for (const log of rcpt.logs) {
  console.log("---");
  console.log("address:", log.address);
  console.log("topics:", log.topics);
  console.log("data:", log.data.slice(0, 200));
}
process.exit(0);
