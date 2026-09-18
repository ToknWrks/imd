#!/usr/bin/env node
// test-v4-execution.mjs — DRY-RUN simulation of the V4 buy path.
// Calls buildV4BuyCall() — the SAME function buyDip() uses to build a real
// transaction — and eth_estimateGas's the result WITHOUT sending it. No
// funds move. Sharing the function (rather than duplicating the calldata
// construction here) means this dry-run can never silently drift from what
// a real buy actually sends.
// Usage: node scripts/test-v4-execution.mjs [tokenAddress] [buyUsd] [symbol] [chainKey]
// Same 4-arg shape as real-test-buy.mjs (symbol is unused here, display only)
// — kept identical on purpose so the two scripts can't be confused for each
// other's argument order. Uses your configured signer from .env (raw key or
// VultiSig), same as real-test-buy.mjs.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { encodeFunctionData } = await import("viem");
const { findBestV4Pool, quoteBuyV4, getEthUsdPrice, buildV4BuyCall } = await import("../dip-swap.mjs");
const { getChain, httpClient } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");

const TOKEN = process.argv[2] ?? "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
const BUY_USD = Number(process.argv[3] ?? 20);
const SYMBOL = process.argv[4] ?? "";
const CHAIN_KEY = process.argv[5] ?? "ethereum";
const dep = getChain(CHAIN_KEY);
if (SYMBOL) console.log(`token: ${SYMBOL}`);

const client = httpClient(CHAIN_KEY);
const signer = await resolveSigner(CHAIN_KEY);
const SIGNER = signer.address;
console.log(`using configured signer: ${SIGNER}`);
const ethUsd = await getEthUsdPrice(CHAIN_KEY);
const ethAmountWei = BigInt(Math.round((BUY_USD / ethUsd) * 1e18));
console.log(`dry-run on ${dep.name}: \$${BUY_USD} → ${(Number(ethAmountWei) / 1e18).toFixed(6)} ETH (ETH=\$${ethUsd.toFixed(2)})`);

const pool = await findBestV4Pool(TOKEN, CHAIN_KEY);
console.log("pool:", pool.poolId.slice(0, 14) + "…", "fee", pool.fee, "ts", pool.tickSpacing, "hooks", pool.hooks === "0x0000000000000000000000000000000000000000" ? "none" : pool.hooks);

const { call, quotedOut, isHooked } = await buildV4BuyCall(pool, TOKEN, ethAmountWei, { slippagePct: 3, recipient: SIGNER, chainKey: CHAIN_KEY });
console.log("quote:", Number(quotedOut) / 1e18, "tokens", isHooked ? "(hooked-pool swap shape)" : "(standard swap shape)");

const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args });

console.log("simulating execute() ...");
try {
  const gas = await client.estimateGas({ account: SIGNER, to: call.address, data, value: call.value });
  console.log(`✅ SIMULATION PASSED — gas estimate: ${gas.toString()}`);
  console.log("This calldata would succeed on-chain. Safe to arm the watcher.");
} catch (e) {
  console.log("❌ SIMULATION FAILED:", String(e.message).slice(0, 400));
  const raw = JSON.stringify(e, Object.getOwnPropertyNames(e));
  const sel = raw.match(/0x[0-9a-f]{8}(?![0-9a-f])/g)?.filter((s) => s !== "0x00000000");
  if (sel) console.log("error selectors seen:", [...new Set(sel)].join(", "));
  process.exit(1);
}
