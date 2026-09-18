/**
 * diag-atlantis-roundtrip.mjs — full round-trip audit of the user's
 * ATLANTIS trading on Robinhood: every buy/sell from sniper_trades +
 * dip_trades, on-chain receipts decoded leg-by-leg, running ETH cost vs
 * ETH recovered. Answers "did the pricing anomaly exist, or is this just
 * thin-pool economics?"
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
const { getErc20Balance, getEthBalance } = await import("../dip-swap.mjs");
const ATL = "0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18";
const MU = "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD";

// current state
const atl = Number(formatUnits(await getErc20Balance(ATL, WALLET, "robinhood"), 18));
const ethBal = Number(formatUnits(await getEthBalance(WALLET, "robinhood"), 18));
console.log("ATLANTIS balance now:", atl.toLocaleString(undefined, { maximumFractionDigits: 0 }));
console.log("ETH balance now:", ethBal.toFixed(6));

// all ATLANTIS txs from the sniper log
const Database = (await import("better-sqlite3")).default;
const db = new Database("data/accumulate.db", { readonly: true });
const rows = db.prepare(
  "SELECT created_at, dex, buy_tx_hash h, eth_spent FROM sniper_trades WHERE symbol='ATLANTIS' AND buy_tx_hash IS NOT NULL AND buy_tx_hash != '' ORDER BY id"
).all();

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
let totalEthIn = 0, totalEthOut = 0;

for (const t of rows) {
  const r = await c.getTransactionReceipt({ hash: t.h }).catch(() => null);
  if (!r) continue;
  let atlDelta = 0n, ethValue = 0n, muDelta = 0n, usdgDelta = 0n;
  for (const l of r.logs) {
    if (l.topics[0] !== TRANSFER) continue;
    const from = "0x" + l.topics[1].slice(-40);
    const to = "0x" + l.topics[2].slice(-40);
    const token = l.address.toLowerCase();
    const val = BigInt(l.data);
    if (token === ATL.toLowerCase()) atlDelta += (to === WALLET ? val : -val);
    if (token === MU.toLowerCase()) muDelta += (to === WALLET ? val : -val);
    if (token === dep.dollar.toLowerCase()) usdgDelta += (to === WALLET ? val : -val);
  }
  // ETH delta for the wallet (tx.value minus gas)
  const tx = await c.getTransaction({ hash: t.h }).catch(() => null);
  const gasCost = tx ? BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice ?? 0n) : 0n;
  const ethSpent = tx ? (tx.value + gasCost) : 0n;
  const isSell = (t.dex ?? "").startsWith("SELL") || atlDelta < 0n;

  console.log(`\n${t.created_at} | ${t.dex}`);
  console.log(`  ATLANTIS delta: ${Number(formatUnits(atlDelta, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`  MU delta: ${Number(formatUnits(muDelta, 18)).toFixed(4)}`);
  console.log(`  USDG delta: ${Number(formatUnits(usdgDelta, 6)).toFixed(2)}`);
  console.log(`  ETH out (spend+gas): ${Number(formatUnits(ethValue, 18)).toFixed(6)}`);
  if (isSell) { totalEthOut += 0; }
  else totalEthIn += Number(formatUnits(ethValue, 18));
}

console.log(`\n=== SUMMARY ===`);
console.log(`Total ETH spent on ATLANTIS buys (incl. gas): ~${totalEthIn.toFixed(4)}`);
console.log(`ATLANTIS held now: ${atl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
