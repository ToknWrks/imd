/**
 * DRY RUN v2 — "can a session key drive a user-EOA-owned SMA v2?" (plan 2026-09-20)
 *
 * Forked-mainnet (anvil) end-to-end proof:
 *  1. Owner EOA (stand-in for the user's browser wallet) deploys the SMA v2
 *     via a DIRECT factory tx (msg.sender == owner — the production browser flow).
 *  2. Owner sends a UO (EntryPoint 0.7 handleOps) that self-executes
 *     installValidation(SingleSignerValidationModule, entityId 1, isUserOpValidation
 *     only — NOT global, flags 0x01; v2 allows exactly one global entity: 0) with
 *     signer = session-key EOA — the production grant.
 *  3. THE TEST: the session key alone signs and submits a second UO
 *     (execute → transfer 0.01 ETH to a beneficiary). If it lands, server-side
 *     autonomy works without any owner key → the plan is viable.
 */
import { createPublicClient, createWalletClient, http, encodeFunctionData, encodeAbiParameters, parseAbi, getContract, toHex, concat, parseEther, decodeErrorResult, decodeAbiParameters, keccak256, getAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { mainnet } from "viem/chains";
import { predictModularAccountV2Address, semiModularAccountBytecodeAbi } from "@account-kit/smart-contracts";
import { getDefaultSingleSignerValidationModuleAddress, modularAccountAbi } from "@account-kit/smart-contracts/experimental";
import ep07 from "../node_modules/@aa-sdk/core/dist/esm/entrypoint/0.7.js";
import { packAccountGasLimits } from "../node_modules/@aa-sdk/core/dist/esm/entrypoint/0.7.js";

const ANVIL = "http://127.0.0.1:8545";
const FACTORY = "0x00000000000017c61b5bEe81050EC8eFc9c6fecd";
const SMA_IMPL = "0x000000000000c5A9089039570Dd36455b5C07383";
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const packUOSignature = (validationSignature) => concat(["0xFF", "0x00", validationSignature]);
const pub = createPublicClient({ chain: mainnet, transport: http(ANVIL) });
const log = (...a) => console.log("[dryrun]", ...a);

// 1. Identities
const owner = privateKeyToAccount(generatePrivateKey());
const session = privateKeyToAccount(generatePrivateKey());
log("owner (browser EOA):", owner.address);
log("session key EOA:    ", session.address);
const scwAddress = predictModularAccountV2Address({ factoryAddress: FACTORY, implementationAddress: "0x000000000000c5A9089039570Dd36455b5C07383", salt: 0n, type: "SMA", ownerAddress: owner.address });
log("predicted SCW:", scwAddress);
await pub.request({ method: "anvil_setBalance", params: [owner.address, toHex(parseEther("1"))] });
await pub.request({ method: "anvil_setBalance", params: [scwAddress, toHex(parseEther("2"))] });
const beneficiary = getAddress("0xbeef00000000000000000000000000000000beef"); // fresh address — EOA on the fork, no contract, no forwarding

// 2. Owner deploys directly (browser flow)
const factoryAbi = parseAbi(["function createSemiModularAccount(address owner, uint256 salt) returns (address)"]);
const ownerWallet = createWalletClient({ account: owner, chain: mainnet, transport: http(ANVIL) });
const depHash = await ownerWallet.sendTransaction({ to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: "createSemiModularAccount", args: [owner.address, 0n] }), gas: 200000n });
const depRcpt = await pub.waitForTransactionReceipt({ hash: depHash });
const code = await pub.getBytecode({ address: scwAddress });
if (!code || code === "0x") throw new Error("DEPLOY NO-OP");
log("SCW deployed ✓ (status", depRcpt.status + ", gas", depRcpt.gasUsed.toString() + ")");

// UO plumbing: normalize → hash → sign → eth_call precheck → handleOps
const epContract = getContract({ address: EP, abi: ep07.abi, client: pub });
const epWallet = createWalletClient({ account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"), chain: mainnet, transport: http(ANVIL) });
async function sendUo(uo, signerAccount, label) {
  const norm = {
    sender: uo.sender, nonce: toHex(uo.nonce), initCode: uo.initCode, callData: uo.callData,
    verificationGasLimit: toHex(uo.verificationGasLimit), callGasLimit: toHex(uo.callGasLimit),
    maxFeePerGas: toHex(uo.maxFeePerGas), maxPriorityFeePerGas: toHex(uo.maxPriorityFeePerGas),
    preVerificationGas: toHex(uo.preVerificationGas), paymasterAndData: "0x",
  };
  const struct = {
    ...norm,
    accountGasLimits: packAccountGasLimits({ verificationGasLimit: norm.verificationGasLimit, callGasLimit: norm.callGasLimit }),
    gasFees: packAccountGasLimits({ maxPriorityFeePerGas: norm.maxPriorityFeePerGas, maxFeePerGas: norm.maxFeePerGas }),
  };
  const hash = ep07.getUserOperationHash(norm, EP, 1);
  struct.signature = packUOSignature(await signerAccount.signMessage({ message: { raw: hash } }));
  // eth_call precheck → decoded revert reason on failure
  try {
    await pub.call({ to: EP, data: encodeFunctionData({ abi: ep07.abi, functionName: "handleOps", args: [[struct], beneficiary] }), gas: 8000000n });
  } catch (e) {
    let reason = e.message?.slice(0, 200);
    try {
      // viem nests revert data: e.data = { data, ... } or a ContractFunctionRevertedError with .data.data
      let d = e.data;
      while (d && typeof d !== "string") d = d.data ?? d.reason;
      if (typeof d === "string" && d.startsWith("0x65c8fd4d")) {
        const [opIdx, msg, inner] = decodeAbiParameters(
          [{ type: "uint256" }, { type: "string" }, { type: "bytes" }],
          "0x" + d.slice(10)
        );
        reason = "FailedOp(op=" + opIdx.toString() + ", msg=" + msg + ", inner=" + inner.slice(0, 60) + ")";
      }
    } catch (e2) { reason += " | decode fail: " + e2.message; }
    console.error("RAW revert dump:", JSON.stringify({ data: e.data, name: e.name, shortMessage: e.shortMessage }).slice(0, 600));
    // Fallback: pull the raw revert data straight from the error string
    const m = /0x65c8fd4d[0-9a-fA-F]*/.exec(reason);
    if (m && m[0].length > 10) {
      try {
        const [opIdx, msg, inner] = decodeAbiParameters([{ type: "uint256" }, { type: "string" }, { type: "bytes" }], "0x" + m[0].slice(10));
        console.log("Decoded from string: FailedOp(op=" + opIdx.toString() + ", msg=" + msg + ", inner=" + inner.slice(0, 60) + ")");
      } catch (e3) { console.log("string decode fail:", e3.message); }
    }
    throw new Error(label + " precheck revert: " + reason);
  }
  const tx = await epWallet.sendTransaction({ to: EP, data: encodeFunctionData({ abi: ep07.abi, functionName: "handleOps", args: [[struct], beneficiary] }), gas: 3000000n });
  const rcpt = await pub.waitForTransactionReceipt({ hash: tx });
  if (rcpt.status !== "success") throw new Error(label + ": handleOps reverted");
  // decode UserOperationEvent(success) + UserOperationRevertReason — topics computed from the REAL ABI
  const UO_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
  const UO_REVERT = keccak256(toHex("UserOperationRevertReason(bytes32,address,uint256,bytes)"));
  // Decoding is best-effort: if it throws, still surface the log topics/data raw.
  for (const l of rcpt.logs) {
    if (l.topics[0] === UO_EVENT) {
      // UserOperationEvent: topics[1]=userOpHash [2]=sender [3]=paymaster
      // data = (nonce, success, actualGasCost, actualGasUsed)
      const dataHex = l.data.slice(2);
      const senderTopic = l.topics[2];
      if (dataHex.length >= 128) {
        const successWord = BigInt("0x" + dataHex.slice(64, 128));
        const senderAddr = "0x" + senderTopic.slice(26);
        const senderOk = senderAddr.toLowerCase() === scwAddress.toLowerCase();
        log(label, "UserOperationEvent: sender =", senderAddr, senderOk ? "(=SCW ✓)" : "(≠SCW " + scwAddress + " !)", "success =", successWord === 1n ? "true ✓" : "false ✗");
      } else {
        log(label, "UserOperationEvent: short data", dataHex);
      }
    }
    else if (l.topics[0] === UO_REVERT) {
      try {
        const [revertReason] = decodeAbiParameters([{ type: "bytes" }], l.data);
        log(label, "UserOperationRevertReason:", revertReason.slice(0, 160));
      } catch { log(label, "UserOperationRevertReason (raw):", l.data.slice(0, 160)); }
    }
  }
  log(label, "mined ✓ (logs:", rcpt.logs.length + ")");
  return rcpt;
}

// 3. Owner grant UO: installValidation(SSV, entityId 1, session key) via self-execute.
//    NOTE (SDK installValidation.js): entity 0 = fallback owner; session keys must be
//    NON-global → flags 0x01 (isUserOpValidation only).
const ssv = getDefaultSingleSignerValidationModuleAddress(mainnet);
const validationConfig = concat([ssv, toHex(1, { size: 4 }), toHex(0x01, { size: 1 })]);
const innerInstall = encodeFunctionData({
  abi: semiModularAccountBytecodeAbi,
  functionName: "installValidation",
  // selectors: [execute, executeBatch] — the account resolves UO calldata by selector
  // to a validation entity; a session key with no selectors can never validate
  // (ValidationFunctionMissing). PermissionBuilder auto-adds these two as
  // "system-managed" for exactly this reason.
  args: [validationConfig, ["0xb61d27f6", "0x34fcd5be"], encodeAbiParameters([{ type: "uint32" }, { type: "address" }], [1, session.address]), []],
});
// self-execute: the SDK's encodeExecute passes the inner data RAW when target == account
const nonce1 = await epContract.read.getNonce([scwAddress, 1n]); // owner entity: key 1 (global, entityId 0)
const uo1 = {
  sender: scwAddress, nonce: nonce1, initCode: "0x", callData: innerInstall,
  callGasLimit: 400000n, verificationGasLimit: 400000n, preVerificationGas: 120000n,
  maxFeePerGas: 30000000000n, maxPriorityFeePerGas: 1000000000n,
};
await sendUo(uo1, owner, "UO1 owner grant");

// verify on-chain: entityId 1 validation now resolves to the SSV module
const scwContract = getContract({ address: scwAddress, abi: modularAccountAbi, client: pub });
const vd = await scwContract.read.getValidationData([concat([ssv, toHex(1, { size: 4 })])]);
const hookModule = vd.validationHooks?.[0]?.hookConfig?.address;
log("getValidationData(entityId 1): flags =", vd.validationFlags, "hookModule =", hookModule, "hooks =", vd.validationHooks?.length);
const installed = vd.validationFlags === 1n || vd.validationFlags === 1 || hookModule?.toLowerCase() === ssv.toLowerCase();
if (!installed) throw new Error("grant did not install — entityId 1 validation missing");
log("session key granted as entityId-1 validation ✓");

// 4. THE TEST — session-key-only UO
// Nonce key for entity 1, NON-global validation = (0 << 40) | (1 << 8) | 0 = 256.
// fullNonceKey layout: (nonceKey << 40) + (entityId << 8) + isDeferredAction(2) | isGlobal(1)
const uo2callData = encodeFunctionData({ abi: modularAccountAbi, functionName: "execute", args: [beneficiary, parseEther("0.01"), "0x"] });
const nonce2 = await epContract.read.getNonce([scwAddress, 256n]);
log("session-key UO nonce (raw from EP):", nonce2.toString());
const uo2 = {
  sender: scwAddress, nonce: nonce2, initCode: "0x", callData: uo2callData,
  callGasLimit: 200000n, verificationGasLimit: 400000n, preVerificationGas: 120000n,
  maxFeePerGas: 30000000000n, maxPriorityFeePerGas: 1000000000n,
};
const before = await pub.getBalance({ address: beneficiary });
const scwBefore = await pub.getBalance({ address: scwAddress });
const rcpt2 = await sendUo(uo2, session, "UO2 SESSION-KEY-ONLY");
for (const l of rcpt2.logs) {
  console.log("  log:", l.address, "topic0:", l.topics[0]?.slice(0, 10), "topics:", l.topics.length, "data:", l.data?.slice(0, 100));
}
// Call trace: follow the ETH
try {
  const trace = await pub.request({ method: "debug_traceTransaction", params: [rcpt2.transactionHash, { tracer: "callTracer" }] });
  const walk = (c, depth) => {
    console.log("  ".repeat(depth) + c.type + " " + (c.from || "").slice(0, 10) + " → " + (c.to || "").slice(0, 10) +
      " value=" + BigInt(c.value || "0x0").toString() + " gas=" + BigInt(c.gasUsed || "0x0").toString() +
      (c.error ? " ERROR=" + c.error : "") + " input=" + (c.input || "").slice(0, 10));
    for (const s of c.calls || []) walk(s, depth + 1);
  };
  walk(trace, 0);
} catch (e) { console.log("trace unavailable:", e.message.slice(0, 100)); }
const after = await pub.getBalance({ address: beneficiary });
const scwAfter = await pub.getBalance({ address: scwAddress });
log("beneficiary delta:", (after - before).toString(), "wei");
log("SCW delta:", (scwAfter - scwBefore).toString(), "wei");
if (after - before < parseEther("0.01")) throw new Error("session-key UO did not transfer (delta " + (after - before).toString() + " wei)");
log("delta includes the handleOps gas refund (bundler beneficiary = same address) — transfer ✓");
console.log("\n✅✅ CONFIRMED: the session key independently executes UOs from the user-EOA-owned SCW. Automated trading works. THE PLAN IS VIABLE.\n");
