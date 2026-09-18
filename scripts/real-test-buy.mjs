#!/usr/bin/env node
// real-test-buy.mjs — ONE small live buy through buyDip() to prove V4 execution.
// Spends real ETH (~$5 + gas). Records a dip_trades row for dashboard visibility.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { formatUnits } = await import("viem");
const { buyDip, getEthUsdPrice } = await import("../dip-swap.mjs");
const { resolveSigner } = await import("../signer.mjs");
const { getChain } = await import("../chains.mjs");
const db = await import("../db.mjs");

const TOKEN = process.argv[2] ?? "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
const BUY_USD = Number(process.argv[3] ?? 5);
const SYMBOL = process.argv[4] ?? "IMD";
const CHAIN_KEY = process.argv[5] ?? "ethereum";
const dep = getChain(CHAIN_KEY);

const ethUsd = await getEthUsdPrice(CHAIN_KEY);
const ethAmountWei = BigInt(Math.round((BUY_USD / ethUsd) * 1e18));
const signer = await resolveSigner(CHAIN_KEY);
console.log(`LIVE TEST on ${dep.name}: buying $${BUY_USD} (${(Number(ethAmountWei) / 1e18).toFixed(6)} ETH) of ${SYMBOL} from ${signer.address}`);
console.log(`wallet ETH balance: ${Number(await signer.getEthBalanceWei()) / 1e18}`);

try {
  const { txHash, quotedOut } = await buyDip(signer, TOKEN, ethAmountWei, { slippagePct: 3, chainKey: CHAIN_KEY });
  console.log(`✅ TX SENT: ${txHash}`);
  console.log(`quoted out: ${Number(quotedOut) / 1e18} ${SYMBOL} (before slippage guard)`);
  const matchingWatcher = db.getActiveDipWatchers().find((w) => (w.chain || "ethereum") === CHAIN_KEY);
  db.insertDipTrade({
    watcher_id: matchingWatcher?.id ?? null,
    sell_tx_hash: null,
    sell_usd: null,
    buy_tx_hash: txHash,
    eth_spent: Number(ethAmountWei) / 1e18,
    token_amount: Number(formatUnits(quotedOut, 18)),
    price_usd: Number(formatUnits(quotedOut, 18)) > 0 ? BUY_USD / Number(formatUnits(quotedOut, 18)) : null,
    execution_kind: "test",
  });
  console.log(`recorded in dip_trades (execution_kind=test) — tx ${txHash} on ${dep.name}`);
} catch (e) {
  console.log("❌ BUY FAILED:", String(e.message).slice(0, 500));
  process.exit(1);
}
