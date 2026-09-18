/**
 * recover-7182.mjs — MA v2 account recovery for 0x7182…8Ad4.
 *
 * Root cause (proven via rangedesk tx 0x9d05…7695): the MA v2 factory requires
 * msg.sender == owner. Our Activate routed the deploy through the vault
 * (msg.sender = vault, owner arg = session key) → silent no-op.
 * Fix: deploy FROM the session key EOA (owner == msg.sender), then sweep the
 * stranded 0.004 ETH out.
 *
 * Phases (each gated — pass a phase number to run it):
 *   1: report balances only (session key EOA, SCW) — read-only
 *   2: deploy createSemiModularAccount(sessionKey, 0) FROM the session key
 *      (requires the session key to hold gas — top it up first if phase 1 says 0)
 *   3: verify deploy (getCode), then sweep the SCW's ETH out via UO
 *
 * Sweep target: SWEEP_TO env or --to 0x… (defaults to the vault/connected wallet).
 * NOTHING is sent without the matching phase argument. Every phase prints what
 * it would do before doing it.
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const phase = process.argv[2] || "1";
const sweepTo = (process.env.SWEEP_TO || process.argv[3] || "").trim();

const { createPublicClient, http, encodeFunctionData, parseAbi, formatEther, parseUnits, getAddress } = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");
const { createWalletClient } = await import("viem");
const { getChain, getEthUsdPriceFor } = await import("../chains.mjs");

const dep = getChain("ethereum");
const pub = createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc()) });
const FACTORY = "0x00000000000017c61b5bEe81050EC8eFc9c6fecd";
const SCW = "0x71827dBf5c242c2F5B0F97b82C092c1594698Ad4";

const sessionKeyAcct = privateKeyToAccount(process.env.AA_SESSION_KEY.startsWith("0x") ? process.env.AA_SESSION_KEY : "0x" + process.env.AA_SESSION_KEY);
const sessionKeyWallet = createWalletClient({ account: sessionKeyAcct, chain: dep.viemChain, transport: http(dep.httpRpc()) });

async function report() {
  const skBal = await pub.getBalance({ address: sessionKeyAcct.address });
  const scwBal = await pub.getBalance({ address: SCW });
  const code = await pub.getCode({ address: SCW });
  const deployed = code && code !== "0x";
  const ethUsd = await getEthUsdPriceFor("ethereum").catch(() => 0);
  console.log(`session key EOA : ${sessionKeyAcct.address} — ${Number(formatEther(skBal)).toFixed(6)} ETH (gas wallet)`);
  console.log(`stranded SCW    : ${SCW} — ${Number(formatEther(scwBal)).toFixed(6)} ETH (~$${(Number(formatEther(scwBal)) * ethUsd).toFixed(2)})`);
  console.log(`SCW deployed    : ${code && code !== "0x" ? "YES" : "no"}`);
  return { skBal, scwBal, deployed: Boolean(code && code !== "0x") };
}

if (phase === "1") {
  console.log("PHASE 1 — read-only status\n");
  await report();
  console.log("\nNext: phase 2 requires the session key EOA to hold gas (~0.0004 ETH).");
  console.log("If it's empty, send gas there from your vault first, then run phase 2.");
  process.exit(0);
}

if (phase === "2") {
  console.log("PHASE 2 — deploy MA v2 account FROM the session key (owner == msg.sender)\n");
  const { deployed } = await report();
  if (deployed) { console.log("Already deployed — nothing to do."); process.exit(0); }
  const skBal = await pub.getBalance({ address: sessionKeyAcct.address });
  if (skBal === 0n) {
    console.log("\nBLOCKED: session key EOA has 0 ETH — it must pay the deploy gas.");
    console.log(`Send ~0.0005 ETH to ${sessionKeyAcct.address} first (from your vault or browser wallet), then re-run phase 2.`);
    process.exit(2);
  }
  const deployGas = await pub.estimateGas({
    account: sessionKeyAcct.address,
    to: FACTORY(),
    data: encodeFunctionData({ abi: FACTORY_ABI(), functionName: "createSemiModularAccount", args: [sessionKeyAcct.address, 0n] }),
  }).catch((e) => { console.log("SIMULATION FAILED:", String(e.message || e).slice(0, 300)); process.exit(3); });
  console.log(`simulated deploy gas: ${deployGas} (~${Number(formatEther(deployGas * 2n))} ETH worst-case cost incl. headroom)`);
  const walletClient = createWalletClient({ account: sessionKeyAcct, chain: dep.viemChain, transport: http(dep.httpRpc()) });
  const txHash = await walletClient.sendTransaction({
    account: sessionKeyAcct,
    chain: dep.viemChain,
    to: FACTORY(),
    data: encodeFunctionData({ abi: FACTORY_ABI(), functionName: "createSemiModularAccount", args: [sessionKeyAcct.address, 0n] }),
    gas: (deployGas * 130n) / 100n, // 30% headroom
  });
  console.log("deploy tx sent:", txHash);
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  console.log("mined. status:", receipt.status, "| gasUsed:", String(receipt.gasUsed), "| logs:", receipt.logs.length);
  const code = await pub.getCode({ address: SCW });
  const created = code && code !== "0x";
  console.log(created ? `✅ ACCOUNT DEPLOYED at ${SCW} (${(code.length / 2 - 1)} bytes)` : "❌ still no code — do NOT proceed; re-diagnose");
  process.exit(created ? 0 : 4);
}

if (phase === "3") {
  console.log("PHASE 3 — sweep stranded ETH out of the SCW via UO\n");
  const { scwBal, deployed } = await report();
  if (!deployed) { console.log("BLOCKED: SCW not deployed yet — run phase 2 first."); process.exit(2); }
  const to = sweepTo && /^0x[0-9a-fA-F]{40}$/.test(sweepTo) ? sweepTo : process.env.CONNECTED_WALLET || null;
  if (!to) { console.log("Provide a sweep destination: --to 0x…  (or CONNECTED_WALLET in .env)"); process.exit(2); }
  console.log(`sweep destination: ${to}`);
  const reserve = 800_000_000_000_000n; // gasReserveWei('ethereum')
  const sweepable = scwBal > reserve ? scwBal - reserve : 0n;
  if (sweepable === 0n) { console.log("nothing sweepable beyond the gas reserve"); process.exit(2); }
  console.log(`sweeping ${Number(formatEther(sweepable)).toFixed(6)} ETH (keeping 0.0008 reserve)…`);
  // IMPORTANT: build the MA v2 client for 0x7182… specifically — smart-account.mjs now
  // defaults to LightAccount (0xFB11…), which is a DIFFERENT account with nothing in it.
  const { createModularAccountV2Client } = await import("@account-kit/smart-contracts");
  const { alchemy, mainnet } = await import("@account-kit/infra");
  const { WalletClientSigner } = await import("@aa-sdk/core");
  const maClient = await createModularAccountV2Client({
    chain: mainnet,
    transport: alchemy({ apiKey: process.env.ALCHEMY_API_KEY }),
    signer: new WalletClientSigner(sessionKeyWallet, "sk"),
    mode: "default",
  });
  const maAddr = getAddress(maClient.account.address);
  if (maAddr.toLowerCase() !== SCW.toLowerCase()) {
    console.log(`ABORT: MA v2 client derived ${maAddr}, expected ${SCW} — refusing to sweep from the wrong account`);
    process.exit(3);
  }
  console.log("sweeping from MA v2 account:", maAddr);
  const { hash } = await maClient.sendUserOperation({ uo: { target: to, data: "0x", value: sweepable } });
  console.log("UO hash:", hash);
  const txHash = await maClient.waitForUserOperationTransaction({ hash });
  console.log("✅ swept — inner tx:", txHash);
  const after = await pub.getBalance({ address: SCW });
  console.log("SCW balance now:", Number(formatEther(after)).toFixed(6), "ETH");
  process.exit(0);
}

console.log(`usage: node scripts/recover-7182.mjs <phase 1|2|3> [--to 0x…]`);
process.exit(1);
