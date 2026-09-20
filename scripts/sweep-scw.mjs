/**
 * One-off recovery: sweep ALL ETH from a user's (possibly undeployed) SCW to
 * an explicit recipient — bypasses moveFunds' owner-resolution, which throws
 * on hosted (no AGENT_PRIVATE_KEY). The first UO auto-deploys the SCW via
 * initCode; the EntryPoint takes its prefund from the SCW's own balance.
 *
 * Usage: node scripts/sweep-scw.mjs <owner-address> <recipient-address>
 * DRY-RUN by default — pass --send to actually broadcast.
 */
import { readFileSync } from "fs";
import { createPublicClient, http, formatEther, parseEther } from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const owner = process.argv[2];
const recipient = process.argv[3];
const SEND = process.argv.includes("--send");
if (!/^0x[0-9a-fA-F]{40}$/.test(owner ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(recipient ?? "")) {
  console.error("usage: node scripts/sweep-scw.mjs <owner> <recipient> [--send]");
  process.exit(1);
}
process.env.MASTER_KEY = readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^MASTER_KEY=(.*)$/m)[1].trim();

const { resolveUserSessionKeyAsync } = await import("../smart-wallet-api.mjs");
const { getSmartAccountClient } = await import("../smart-account.mjs");
const { getChain } = await import("../chains.mjs");

const dep = getChain("ethereum");
const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const alchemyKey = env.match(/^ALCHEMY_API_KEY=(.*)$/m)[1].trim();
const pub = createPublicClient({ chain: mainnet, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`) });

const sk = await resolveUserSessionKeyAsync(owner);
if (!sk) { console.error("no session key for", owner); process.exit(1); }
const client = await getSmartAccountClient("ethereum", { sessionKey: sk });
const scw = client.account.address;
const code = await pub.getCode({ address: scw }).catch(() => "0x");
const bal = await pub.getBalance({ address: scw });
console.log("SCW:", scw, "| deployed:", code && code !== "0x" ? "yes" : "no", "| balance:", formatEther(bal), "ETH");
if (bal === 0n) { console.log("nothing to sweep"); process.exit(0); }

// First UO auto-deploys (initCode) — the EntryPoint takes prefund from the
// account itself. Send everything minus a safety margin for that prefund.
const uo = { target: recipient, data: "0x", value: bal };
const built = await client.buildUserOperation({ uo });
const gasCost = BigInt(built.preVerificationGas) +
  BigInt(built.verificationGasLimit) * BigInt(built.maxFeePerGas) +
  BigInt(built.callGasLimit) * BigInt(built.maxFeePerGas);
const sendable = bal > gasCost ? bal - gasCost : 0n;
console.log("gas cost estimate:", formatEther(gasCost), "ETH");
console.log("sendable:", formatEther(sendable), "ETH →", recipient);
if (sendable === 0n) { console.error("gas exceeds balance — nothing sendable"); process.exit(1); }

if (!SEND) {
  console.log("\nDRY RUN — re-run with --send to broadcast.");
  process.exit(0);
}
const finalUo = { target: recipient, data: "0x", value: sendable };
const { hash } = await client.sendUserOperation({ uo: finalUo });
const txHash = await client.waitForUserOperationTransaction({ hash });
console.log("swept:", formatEther(sendable), "ETH →", recipient, "| tx:", txHash);
