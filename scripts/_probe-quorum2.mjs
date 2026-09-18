// The exit transfer exists (QUORUM out → PoolManager in the same tx).
// Now replicate the exact wallet-position logic for that tx: did the USDG-in
// side of the sale get captured? Print the IN transfers for the main wallet
// around the exit block, checking USDG incoming.
import { readFileSync } from "fs";
const env = Object.fromEntries(readFileSync("/Users/lancepitman/accumulate/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.match(/^([^#=][^=]*)=(.*)$/)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
const url = `https://robinhood-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const QUORUM = "0xa6452fd7134218f62056a304eaf501f8714a26b9";
const W = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";
async function transfers(direction, contractAddresses) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ fromBlock: "0x0", toBlock: "latest", category: ["erc20"], withMetadata: false, order: "asc", maxCount: "0x3e8", contractAddresses, [direction === "in" ? "toAddress" : "fromAddress"]: W }] }) });
  const body = await res.json();
  return body.result?.transfers ?? [];
}
const incoming = await transfers("in", [QUORUM, USDG, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"]);
// group like wallet-position does
const EXIT_HASH = "0xb33ea908ab5501b900bed476c67a0cce16b79e111b158b194b6640950ae9c594";
const byHash = {};
for (const t of incoming) (byHash[t.hash] ??= []).push(t);
const exitLegs = byHash[EXIT_HASH];
console.log("IN-side legs of the exit tx:", exitLegs ? JSON.stringify(exitLegs.map((t) => ({ asset: t.asset, value: t.value, to: t.to, from: t.from })), null, 1) : "NONE — the sale proceeds did NOT arrive as USDG/WETH in the wallet");
// also list all USDG-in transfers near that block for the wallet
const usdgIn = incoming.filter((t) => t.asset === "USDG");
console.log("USDG-in count:", usdgIn.length, "latest:", JSON.stringify(usdgIn.slice(-3).map((t) => ({ block: t.blockNum, value: t.value })), null, 1));
process.exit(0);
