// QUORUM buys show NO USDG/WETH spend either — where did QUORUM come from?
// Two candidate wallets: the MM bot (0x217C…) holds some QUORUM trades. Check
// the MM wallet's QUORUM story, and whether the main wallet's QUORUM came via
// internal transfers (mint/airdrop/swap via LONG platform stock path).
import { readFileSync } from "fs";
const env = Object.fromEntries(readFileSync("/Users/lancepitman/accumulate/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.match(/^([^#=][^=]*)=(.*)$/)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
const url = `https://robinhood-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
const QUORUM = "0xa6452fd7134218f62056a304eaf501f8714a26b9";
const MM = "0x217C05f5D1D1E595BBae94534540B803bfC4563B";
async function transfers(direction, wallet) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ fromBlock: "0x0", toBlock: "latest", category: ["erc20"], withMetadata: false, order: "asc", maxCount: "0x3e8", contractAddresses: [QUORUM], [direction === "in" ? "toAddress" : "fromAddress"]: wallet }] }) });
  return (await res.json()).result.transfers ?? [];
}
const [i, o] = await Promise.all([transfers("in", MM), transfers("out", MM)]);
console.log("MM wallet QUORUM in:", i.length, "out:", o.length);
for (const t of i) console.log("  IN ", t.value?.toFixed?.(0), "blk", parseInt(t.blockNum, 16), "from", t.from?.slice(0, 10), "tx", t.hash.slice(0, 12));
for (const t of o) console.log("  OUT", t.value?.toFixed?.(0), "blk", parseInt(t.blockNum, 16), "to  ", t.to?.slice(0, 10), "tx", t.hash.slice(0, 12));
// Also: who sent the main wallet its QUORUM? Check the from of the biggest buys.
const MAIN = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";
const ins = await transfers("in", MAIN);
for (const t of ins.filter((x) => x.value > 100000)) console.log("MAIN big in:", t.value?.toFixed?.(0), "from", t.from, "tx", t.hash.slice(0, 12));
process.exit(0);
