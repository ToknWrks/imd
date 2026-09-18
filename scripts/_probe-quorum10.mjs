// Full accounting of QUORUM: reconstruct every buy/sell from the transfer
// history to find how much the wallet SPENT total vs what it holds now —
// then compare against the exit that shows no proceeds.
import { readFileSync } from "fs";
try {
  const env = Object.fromEntries(
    readFileSync("/Users/lancepitman/accumulate/.env", "utf8").split("\n")
      .map((l) => l.match(/^([^#=][^=]*)=(.*)$/)).filter(Boolean)
      .map((m) => [m[1].trim(), m[2].trim().replace(/^["']|["']$/g, "")]));
  for (const [k, v] of Object.entries(env)) process.env[k] ??= v;
} catch {}
const { computeWalletPosition } = await import("../wallet-position.mjs");
const { getDipWatcher } = await import("../db.mjs");
const w = getDipWatcher("56277e4d-f074-4f71-97df-5b1f3d8242a3"); // QUORUM

// Pull the transfers exactly like fetchTransfers does, but keep tx grouping
// so we can list the wallet's complete QUORUM+USDG+WETH story.
const dep = (await import("../chains.mjs")).getChain(w.chain || "robinhood");
const url = `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const wallet = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";
const contracts = [w.contract_address, dep.dollar, dep.weth].map((a) => a.toLowerCase());
async function transfers(direction) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ fromBlock: "0x0", toBlock: "latest", category: ["erc20"], withMetadata: false, order: "asc", maxCount: "0x3e8", contractAddresses: contracts, [direction === "in" ? "toAddress" : "fromAddress"]: wallet }] }) });
  return (await res.json()).result.transfers ?? [];
}
const [incoming, outgoing] = await Promise.all([transfers("in"), transfers("out")]);
const byTx = new Map();
const bump = (hash, block, field, amount) => {
  const e = byTx.get(hash) ?? { block, tokenIn: 0, tokenOut: 0, usdcIn: 0, usdcOut: 0, wethIn: 0, wethOut: 0 };
  e[field] += amount; byTx.set(hash, e);
};
const rawAmount = (t, dec) => Number(t.value) ?? (parseInt(t.rawContract?.value ?? "0x0", 16) / 10 ** dec);
for (const t of incoming) {
  const addr = t.rawContract?.address?.toLowerCase();
  const isToken = addr === w.contract_address.toLowerCase();
  const isUsdg = addr === dep.dollar.toLowerCase();
  bump(t.hash, parseInt(t.blockNum, 16), isToken ? "tokenIn" : isUsdg ? "usdcIn" : "wethIn", t.value ?? 0);
}
for (const t of outgoing) {
  const addr = t.rawContract?.address?.toLowerCase();
  const isToken = addr === w.contract_address.toLowerCase();
  const isUsdg = addr === dep.dollar.toLowerCase();
  bump(t.hash, parseInt(t.blockNum, 16), isToken ? "tokenOut" : isUsdg ? "usdcOut" : "wethOut", t.value ?? 0);
}
let spentUsd = 0, receivedUsdg = 0;
for (const [hash, e] of [...byTx.entries()].sort((a, b) => a[1].block - b[1].block)) {
  if (e.tokenIn > 0) spentUsd += (e.usdcOut ?? 0) + (e.wethOut ?? 0);
  if (e.tokenOut > 0) receivedUsdg += e.usdcIn ?? 0;
  console.log(`blk ${e.block} in:${e.tokenIn.toFixed(0)}Q/${e.usdcIn?.toFixed(2) ?? 0}U/${e.wethIn?.toFixed(4) ?? 0}W out:${e.tokenOut.toFixed(0)}Q/${e.usdcOut?.toFixed(2) ?? 0}U/${e.wethOut?.toFixed(4) ?? 0}W  ${hash.slice(0, 14)}…`);
}
console.log("\nTOTAL USDG spent on buys:", spentUsd.toFixed(2));
console.log("TOTAL USDG received on sells:", receivedUsdg.toFixed(2));
process.exit(0);
