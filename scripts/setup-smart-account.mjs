#!/usr/bin/env node
// setup-smart-account.mjs — one-time interactive setup for the AA signer mode.
//
// What it does (LOCAL machine, owner key present — never run on the VPS):
//   1. Generates/loads the session key (the VPS-held burner signing key).
//   2. Derives the counterfactual Modular Account v2 address for it.
//   3. Prints the exact .env lines to paste on the VPS.
//
// PHASE 1 model (honest): the session key IS the account owner until the
// Phase 2 SessionKeyPlugin is installed. Fund this account with ONLY the
// active plans' budget + gas. See docs/smart-account-signer.md.
//
// Usage:
//   node scripts/setup-smart-account.mjs                 # generate a fresh session key
//   node scripts/setup-smart-account.mjs 0xdeadbeef...   # derive address for an existing key
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const alchemyKey = process.env.ALCHEMY_API_KEY?.trim();
if (!alchemyKey) {
  console.error("ALCHEMY_API_KEY must be set in .env first (Settings tab → Alchemy).");
  process.exit(1);
}

const existing = process.argv[2];
let sessionKey;
if (existing && existing.startsWith("0x") && existing.length === 66) {
  sessionKey = existing;
  console.log("Using the session key you supplied.");
} else {
  sessionKey = generatePrivateKey();
  console.log("Generated a FRESH session key. Store it in your password manager NOW —");
  console.log("it is the only copy shown here and it controls the trading account.\n");
}
const account = privateKeyToAccount(sessionKey);

const { alchemy, mainnet } = await import("@account-kit/infra");
const { createModularAccountV2Client } = await import("@account-kit/smart-contracts");
const { WalletClientSigner } = await import("@aa-sdk/core");
const { createWalletClient, http } = await import("viem");

const walletClient = createWalletClient({
  account,
  chain: mainnet,
  transport: http(`https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`),
});

console.log("Deriving counterfactual account address (no chain write)…");
const signer = new WalletClientSigner(walletClient, "setup");
const client = await createModularAccountV2Client({
  chain: mainnet,
  transport: alchemy({ apiKey: alchemyKey }),
  signer,
  mode: "default",
});
const address = client.account.address;

console.log("\n──────────────────────────────────────────────────────────────");
console.log("Session key (VPS .env → AA_SESSION_KEY):");
console.log("  " + sessionKey);
console.log("\nSmart account address (counterfactual — safe to fund NOW):");
console.log("  " + address);
console.log("\nView it: https://etherscan.io/address/" + address);
console.log("──────────────────────────────────────────────────────────────");
console.log("\nVPS .env additions:");
console.log("  SMART_ACCOUNT_ACTIVE=true");
console.log("  AA_SESSION_KEY=<the key above>");
console.log("  (VAULT_ACTIVE must be false/absent on the VPS)");
console.log("\nFund the account with the plan budget + ~0.001 ETH gas float.");
console.log("First UserOperation auto-deploys the account (factory-paid by the account itself).");
console.log("Phase 2 (on-chain spend caps via SessionKeyPlugin) is tracked in docs/smart-account-signer.md.");
