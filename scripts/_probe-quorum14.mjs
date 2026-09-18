// Check the LATEST probe tx (id 40): does USDG actually arrive at the wallet?
import { readFileSync } from "fs";
import { createPublicClient, http, defineChain } from "viem";
const env = Object.fromEntries(readFileSync("/Users/lancepitman/accumulate/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.match(/^([^#=][^=]*)=(.*)$/)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
const robinhood = defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const HASH = "0x08bb6ec38154eb83952276b01921597e7ce7f473b34e1818d3caf4022283f9c6";
const W = "0xa71fb297aa443adfc22ff74981d8c067ec3475cb";
const rcpt = await c.getTransactionReceipt({ hash: HASH });
console.log("status:", rcpt.status, "logs:", rcpt.logs.length);
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
let usdgToWallet = 0n;
for (const log of rcpt.logs) {
  if (log.address.toLowerCase() === USDG) {
    const to = "0x" + log.topics[2].slice(26);
    const amt = BigInt(log.data);
    if (to === W) usdgToWallet += amt;
    console.log("USDG move:", Number(amt) / 1e6, "→", to.slice(0, 10), to === W ? "← WALLET" : "");
  }
}
console.log(usdgToWallet > 0n ? `VERDICT: delivered — wallet received ${Number(usdgToWallet) / 1e6} USDG` : "VERDICT: NO USDG to wallet — probe-DELIVERED classification is WRONG");
process.exit(0);
