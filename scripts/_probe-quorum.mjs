// Read-only: fetch QUORUM's transfer history from Alchemy exactly as
// wallet-position does, and check whether the exit sale (token out + USDG in)
// appears.
import { readFileSync } from "fs";
const env = Object.fromEntries(readFileSync("/Users/lancepitman/accumulate/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.match(/^([^#=][^=]*)=(.*)$/)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
const key = env.ALCHEMY_API_KEY;
const url = `https://robinhood-mainnet.g.alchemy.com/v2/${key}`;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const QUORUM = "0xa6452fd7134218f62056a304eaf501f8714a26b9";
// wallet = the main signer wallet — get from watcher? Use the MM wallet + main wallet?
// dashboard computes for the app's signer wallet; find it in the DB if stored, else use both.
const wallets = ["0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb", "0x217C05f5D1D1E595BBae94534540B803bfC4563B"];
console.log("env wallet:", wallets);
async function transfers(direction, wallet) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ fromBlock: "0x0", toBlock: "latest", category: ["erc20"], withMetadata: false, order: "desc", maxCount: "0x32", contractAddresses: [QUORUM, USDG], [direction === "in" ? "toAddress" : "fromAddress"]: wallet }] }) });
  const body = await res.json();
  return body.result?.transfers ?? body.error ?? [];
}
for (const w of wallets) {
  const out = await transfers("out", w);
  console.log("OUT transfers:", out.length, JSON.stringify(out.slice(0, 3), null, 1).slice(0, 800));
}
process.exit(0);
