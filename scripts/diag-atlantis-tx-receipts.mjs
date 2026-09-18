/**
 * diag-atlantis-tx-receipts.mjs — decode the user's recent ATLANTIS txs:
 * exact ETH/USDG/MU flows and ATLANTIS received per tx. Answers
 * "I bought 0.01 ETH — why did I get $44 worth?".
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

for (const line of readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { getChain } = await import("../chains.mjs");
const { createPublicClient, http, formatUnits } = await import("viem");
const dep = getChain("robinhood");
const c = createPublicClient({ transport: http(dep.httpRpc()) });

const WALLET = "0xa71fb297aa443adfc22ff74981d8c067ec3475cb";
const ATL = "0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18";
const MU = "0xff080c8ce2e5feada ca0da81314ae59d232d4afd".replace(" ", "");
const USDG = dep.dollar.toLowerCase();
const WETH = dep.weth.toLowerCase();

const Database = (await import("better-sqlite3")).default;
const db = new Database("data/accumulate.db", { readonly: true });
const rows = db.prepare(
  "SELECT created_at, dex, buy_tx_hash h, eth_spent FROM sniper_trades WHERE symbol='ATLANTIS' AND buy_tx_hash IS NOT NULL AND buy_tx_hash != '' ORDER BY id DESC LIMIT 6"
).all();

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

for (const t of rows) {
  console.log(`\n=== ${t.created_at} | ${t.dex} | eth_spent=${t.eth_spent} ===`);
  try {
    const r = await c.getTransactionReceipt({ hash: t.h });
    let atlIn = 0n, usdgIn = 0n, usdgOut = 0n, muIn = 0n, wethIn = 0n;
    for (const l of r.logs) {
      if (l.topics[0] !== TRANSFER) continue;
      const from = "0x" + l.topics[1].slice(-40);
      const to = "0x" + l.topics[2].slice(-40);
      const token = l.address.toLowerCase();
      const val = BigInt(l.data);
      if (token === ATL && to === WALLET) atlIn += val;
      if (token === USDG && to === WALLET) usdgIn += val;
      if (token === USDG && from === WALLET) usdgOut += val;
      if (token === MU && to === WALLET) muIn += val;
      if (token === WETH && to === WALLET) wethIn += val;
    }
    console.log("  ATLANTIS received:", Number(formatUnits(atlIn, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 }));
    if (usdgIn > 0n) console.log("  USDG in:", Number(formatUnits(usdgIn, 6)));
    if (usdgOut > 0n) console.log("  USDG out:", Number(formatUnits(usdgOut, 6)));
    if (muIn > 0n) console.log("  MU in:", Number(formatUnits(muIn, 18)).toFixed(2));
    if (wethIn > 0n) console.log("  WETH in:", Number(formatUnits(wethIn, 18)).toFixed(4));
    console.log("  status:", r.status, "| gas:", r.gasUsed.toString());
  } catch (e) {
    console.log("  receipt ERR:", String(e.message ?? e).slice(0, 120));
  }
}
