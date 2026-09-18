// Where did the exit proceeds go? Look up the full tx and trace USDG movement.
import { readFileSync } from "fs";
import { createPublicClient, http, defineChain, parseAbi } from "viem";
const env = Object.fromEntries(readFileSync("/Users/lancepitman/accumulate/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.match(/^([^#=][^=]*)=(.*)$/)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
const robinhood = defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const HASH = "0xb33ea908ab5501b900bed476c67a0cce16b79e111b158b194b6640950ae9c594";
const rcpt = await createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") }).getTransactionReceipt({ hash: HASH });
console.log("status:", rcpt.status, "logs:", rcpt.logs.length);
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const W = "0xa71fb297aa443adfc22ff74981d8c067ec3475cb";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
for (const log of rcpt.logs) {
  if (log.address.toLowerCase() === USDG) {
    const from = "0x" + log.topics[1].slice(26);
    const to = "0x" + log.topics[2].slice(26);
    const val = BigInt(log.data) / 10n ** 6n;
    console.log("USDG move:", val.toString(), "USDG", from.slice(0,10), "→", to.slice(0,10), to === W ? "← WALLET" : "");
  }
}
// native ETH out to wallet?
console.log("tx value (native):", rcpt.value);
process.exit(0);
