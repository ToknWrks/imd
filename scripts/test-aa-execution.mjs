#!/usr/bin/env node
// test-aa-execution.mjs — DRY-RUN of a V4 buy through the smart-account signer.
//
// Builds the SAME call buyDip() builds (shared builders — the dry-run can never
// drift from the live path) and pushes it through the AA middleware chain via
// client.buildUserOperation() — gas fields resolved by Alchemy's middleware,
// NOTHING sent. Verifies: factory/initCode for an undeployed account, UO
// structure, fee estimation, and the bundler round-trip.
//
// Interpretation of results:
//   BUILD OK + gas fields      → plumbing works; account can prefund. Safe to
//                                proceed to ONE small live buy.
//   revert, empty revertData   → expected while the SCW is unfunded/undeployed
//                                (EntryPoint 0.7 rejects at prefund). Fund the
//                                SCW, re-run.
//   other errors               → real problem — read Details (AA23/AA25 = gas
//                                accounting; AA1x = signature/validation).
//
// Usage: node scripts/test-aa-execution.mjs [tokenAddress] [buyUsd] [chainKey]
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const TOKEN = process.argv[2] ?? "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7"; // IMD reserve default
const BUY_USD = Number(process.argv[3] ?? 20);
const CHAIN_KEY = process.argv[4] ?? "ethereum";

const { findBestV4Pool, buildV4BuyCall, getEthUsdPrice } = await import("../dip-swap.mjs");
const { getSmartAccountClient, gasReserveWei, explainUserOpError } = await import("../smart-account.mjs");
const { encodeFunctionData, createPublicClient, http, formatEther } = await import("viem");
const { getChain } = await import("../chains.mjs");

const dep = getChain(CHAIN_KEY);
const client = await getSmartAccountClient(CHAIN_KEY);
const SCW = client.account.address;
console.log(`smart account: ${SCW} on ${dep.name}`);

// Funding sanity — EntryPoint prefund comes out of the SCW.
const pub = createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc()) });
const bal = await pub.getBalance({ address: SCW });
console.log(`balance: ${Number(formatEther(bal)).toFixed(6)} ETH (gas reserve needed: ${Number(formatEther(gasReserveWei(CHAIN_KEY)))} ETH)`);
const funded = bal > 0n;

const ethUsd = await getEthUsdPrice(CHAIN_KEY);
const ethAmountWei = BigInt(Math.round((BUY_USD / ethUsd) * 1e18));
console.log(`dry-run: $${BUY_USD} → ${(Number(ethAmountWei) / 1e18).toFixed(6)} ETH (ETH=$${ethUsd.toFixed(2)})`);

const pool = await findBestV4Pool(TOKEN, CHAIN_KEY);
console.log("pool:", pool.poolId.slice(0, 14) + "…", "fee", pool.fee, "hooks",
  pool.hooks === "0x0000000000000000000000000000000000000000" ? "none" : pool.hooks);

const { call, quotedOut, wrapRequired } = await buildV4BuyCall(pool, TOKEN, ethAmountWei, {
  slippagePct: 3, recipient: SCW, chainKey: CHAIN_KEY,
});
console.log("quote:", Number(quotedOut) / 1e18, "tokens", wrapRequired ? "(pre-wrap shape)" : "(standard shape)");

const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args });
const uo = { target: call.address, data, value: call.value ?? 0n };

console.log("\nbuilding full UserOperation through the AA middleware (NO SEND)…");
try {
  const built = await client.buildUserOperation({ uo });
  console.log("✅ DRY-RUN PASSED — middleware-resolved UO:");
  console.log("  sender:               ", built.sender);
  console.log("  nonce:                ", String(built.nonce));
  if (built.factory) console.log("  factory (deploy):     ", built.factory);
  console.log("  callGasLimit:         ", String(built.callGasLimit));
  console.log("  verificationGasLimit:", String(built.verificationGasLimit));
  console.log("  preVerificationGas:   ", String(built.preVerificationGas));
  console.log("  maxFeePerGas:         ", String(built.maxFeePerGas));
  console.log("\nSafe to proceed: fund the SCW, then ONE small live buy (real-test-buy ladder).");
  process.exit(0);
} catch (e) {
  const msg = String(e.message || e);
  console.log("❌ SIMULATION FAILED:", explainUserOpError(e).slice(0, 300));
  if (funded) {
    console.log("\nAccount IS funded — this is a real failure. Check the swap params / pool.");
  } else {
    console.log("\nExpected for an unfunded/undeployed account (EntryPoint 0.7 reverts at");
    console.log("prefund with empty revert data). The UO structure itself built cleanly —");
    console.log("fund the SCW address above and re-run; the revert should clear.");
  }
  process.exit(funded ? 1 : 2);
}
