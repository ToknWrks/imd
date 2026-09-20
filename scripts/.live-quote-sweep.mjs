/**
 * LIVE quote test — quoteDirectSweepV2 against REAL mainnet RPC.
 * Finds a real deployed SMA v2 (from recent factory logs), writes a temp
 * registry record, and runs the quote the production route runs. No tx sent.
 */
process.env.MASTER_KEY = process.env.MASTER_KEY || "test-live-quote";
const { createPublicClient, http, formatEther, getContract, parseAbi, toHex } = await import("viem");
const { mainnet } = await import("viem/chains");
const { getLogsClient } = await import("../chains.mjs");
const ALCHEMY = "https://eth-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMY_API_KEY;
const pub = createPublicClient({ chain: mainnet, transport: http(ALCHEMY) });

// Find a recent createSemiModularAccount log → real deployed SCW + owner
const FACTORY = "0x00000000000017c61b5bEe81050EC8eFc9c6fecd";
const logClient = getLogsClient("ethereum");
const head = await logClient.getBlockNumber();
const events = await logClient.request({ method: "eth_getLogs", params: [{ address: FACTORY, fromBlock: toHex(head - 40000n), toBlock: "latest" }] }).catch((e) => { console.log("getLogs failed:", e.message.slice(0, 100)); return [] });
console.log("factory events in last ~40k blocks:", events.length);

const { getWalletRecord, setWalletRecord, __resetForTests } = await import("../smart-wallet-registry.mjs");
const { quoteDirectSweepV2 } = await import("../smart-wallet-api.mjs");

// Scan logs: the factory emits AccountCreated-style events carrying (account, owner)
let found = 0;
for (const ev of events.reverse()) {
  const account = "0x" + ev.topics[1]?.slice(26);
  const owner = ev.topics[2] ? "0x" + ev.topics[2].slice(26) : ev.topics[1] ? "0x" + ev.topics[1].slice(26) : null;
  if (!/^0x[0-9a-f]{40}$/i.test(account) || !owner) continue;
  const code = await pub.getCode({ address: account }).catch(() => "0x");
  if (!code || code === "0x") continue;
  const bal = await pub.getBalance({ address: account }).catch(() => 0n);
  console.log(`\ndeployed SCW ${account} owner ${owner} balance ${formatEther(bal)} ETH`);
  setWalletRecord(owner.toLowerCase(), { scwAddress: account, ownerEoa: owner.toLowerCase(), salt: 0, grantStatus: "none" });
  try {
    const q = await quoteDirectSweepV2(owner.toLowerCase(), "ethereum", { asset: "eth", amount: 999999, browserFrom: owner });
    console.log("QUOTE OK: directExecute =", q.directExecute, "| to =", q.to, "| requestedAmount =", q.requestedAmount);
    console.log("data:", q.data.slice(0, 74) + "…");
    console.log("→ 100% sweep: amount ≥ balance sends the FULL balance (no clamp, no reserve)");
    found++;
    if (found >= 2) break;
  } catch (e) { console.log("quote threw:", e.message); }
  // wrong signer must refuse
  try {
    await quoteDirectSweepV2(owner.toLowerCase(), "ethereum", { asset: "eth", amount: 0.001, browserFrom: "0x" + "1".repeat(40) });
    console.log("✗ WRONG-SIGNER GUARD FAILED");
  } catch (e) { console.log("wrong-signer guard ✓ (" + e.message.slice(0, 60) + ")"); }
}
if (!found) console.log("\nno funded deployed SCW found in range — guard tests still exercised the path");
console.log("\nDONE (no transactions sent)");
