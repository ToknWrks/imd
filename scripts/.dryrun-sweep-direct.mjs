/**
 * DRY RUN — can the owner EOA call `execute` DIRECTLY on the SMA v2,
 * bypassing the EntryPoint? (2026-09-20 sweep-UX plan)
 *
 * If yes → the "Move out" sweep becomes a plain browser-signed EOA tx:
 *   SCW sends balance − 0 wei (100.0000% of ETH), gas paid by the owner EOA
 *   from OUTSIDE the SCW. No prefund, no deposit dust, no clamp.
 * If it reverts OnlyEntryPoint → fall back to the tight-gas UO sweep.
 */
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, getContract, toHex, parseEther, formatEther, getAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { mainnet } from "viem/chains";
import { predictModularAccountV2Address } from "@account-kit/smart-contracts";

const ANVIL = "http://127.0.0.1:8545";
const FACTORY = "0x00000000000017c61b5bEe81050EC8eFc9c6fecd";
const pub = createPublicClient({ chain: mainnet, transport: http(ANVIL) });
const log = (...a) => console.log("[dryrun-sweep]", ...a);

const owner = privateKeyToAccount(generatePrivateKey());
const scwAddress = getAddress(predictModularAccountV2Address({
  factoryAddress: FACTORY,
  implementationAddress: "0x000000000000c5A9089039570Dd36455b5C07383",
  salt: 0n, type: "SMA", ownerAddress: owner.address,
}));
log("owner:", owner.address, " SCW:", scwAddress);
await pub.request({ method: "anvil_setBalance", params: [owner.address, toHex(parseEther("1"))] });
await pub.request({ method: "anvil_setBalance", params: [scwAddress, toHex(parseEther("2"))] });
const beneficiary = getAddress("0xbeef00000000000000000000000000000000beef");

// Deploy via the production browser path
const factoryAbi = parseAbi(["function createSemiModularAccount(address owner, uint256 salt) returns (address)"]);
const ownerWallet = createWalletClient({ account: owner, chain: mainnet, transport: http(ANVIL) });
const depHash = await ownerWallet.sendTransaction({ to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: "createSemiModularAccount", args: [owner.address, 0n] }), gas: 200000n });
await pub.waitForTransactionReceipt({ hash: depHash });
log("SCW deployed ✓");

const scwAbi = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
]);

async function tryDirect(label, callData, value = 0n) {
  try {
    const h = await ownerWallet.sendTransaction({ to: scwAddress, data: callData, value, gas: 200000n });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    log(label, "→ status", r.status, "gas", r.gasUsed.toString());
    return r.status === "success";
  } catch (e) {
    const msg = String(e.message || e).slice(0, 140);
    log(label, "→ REVERT:", msg);
    return false;
  }
}

const balBefore = await pub.getBalance({ address: beneficiary });
const scwBefore = await pub.getBalance({ address: scwAddress });

// Test 1: plain execute
const ok1 = await tryDirect("execute (plain)", encodeFunctionData({ abi: scwAbi, functionName: "execute", args: [beneficiary, parseEther("0.5"), "0x"] }));

// Test 2: executeBatch
const ok2 = ok1 ? false : await tryDirect("executeBatch", encodeFunctionData({ abi: scwAbi, functionName: "executeBatch", args: [[{ target: beneficiary, value: parseEther("0.5"), data: "0x" }]] }));

const balAfter = await pub.getBalance({ address: beneficiary });
const scwAfter = await pub.getBalance({ address: scwAddress });
log("beneficiary delta:", formatEther(balAfter - balBefore), "ETH");
log("SCW delta:        ", formatEther(scwBefore - scwAfter), "ETH (should be exactly 0.5 if success — no gas taken)");
if ((ok1 || ok2) && balAfter - balBefore !== parseEther("0.5")) throw new Error("transfer landed but delta wrong");
if (ok1 || ok2) console.log("\n✅ DIRECT OWNER EXECUTE WORKS — 100.0000% sweep is possible, gas from the owner EOA outside the SCW.\n");
else console.log("\n❌ DIRECT EXECUTE REVERTS — must stay on the EntryPoint UO path (use tight-gas clamp).\n");
