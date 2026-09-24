/**
 * smart-account.mjs — per-user smart-wallet signer backend (server-side).
 *
 * v2 ONLY (v1 removed 2026-09-24). Every wallet is an Alchemy Semi-Modular
 * Account v2 OWNED BY THE USER'S EOA (CREATE2 from factory
 * createSemiModularAccount(ownerEoa, salt)). The server never owns anything:
 * when the user enables automation, a server-held session key is installed
 * as the ENTITY-1 operator (SingleSignerValidationModule) and signs
 * UserOperations for that one wallet. The legacy v1 model (a burner session
 * key that OWNED a MultiOwnerLightAccount, plus the global AA_SESSION_KEY env
 * signer) is gone — it derived orphan addresses and confused wallet identity.
 *
 * Interface contract (must match signer.mjs exactly):
 *   { kind, address, getEthBalanceWei(), callContract({ address, abi, functionName, args, value }) → txHash }
 * callContract RESOLVES to the UserOperation's inner transaction hash, so all
 * downstream waitForTransactionReceipt / assertTxSucceeded / gas-ledger code
 * works unchanged.
 */
import { WalletClientSigner } from "@aa-sdk/core";
import { alchemy, mainnet, base, defineAlchemyChain } from "@account-kit/infra";
import { predictModularAccountV2Address } from "@account-kit/smart-contracts";
import { getDefaultSingleSignerValidationModuleAddress } from "@account-kit/smart-contracts/experimental";
import { createWalletClient, createPublicClient, http, getAddress, encodeFunctionData, concat } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChain } from "./chains.mjs";

// ── User-EOA-owned SCW derivation (plan 2026-09-20, "kill the backup-key problem") ──
// New wallets derive their smart account from the CONNECTED EOA (the owner),
// not from a server-held session key. Verified on a mainnet fork 2026-09-20:
// predictModularAccountV2Address({ type: "SMA" }) reproduces the factory's
// CREATE2 address exactly, and a direct owner EOA tx to
// createSemiModularAccount(owner, 0) deploys at the predicted address (97,772 gas).
export const MAV2_FACTORY = "0x00000000000017c61b5bEe81050EC8eFc9c6fecd";
export const SMAV2_IMPL = "0x000000000000c5A9089039570Dd36455b5C07383";

/**
 * Deterministic counterfactual SCW address for a user-EOA-owned SMA v2.
 * Pure math — no key, no RPC. Same (chain, eoa, salt) → same address, which is
 * the property the registry relies on for v2 records.
 */
export function predictEoaOwnedScwAddress(chainKey, eoaAddress, salt = 0n) {
  const accountKitChain = accountKitChainFor(chainKey);
  return getAddress(predictModularAccountV2Address({
    factoryAddress: MAV2_FACTORY,
    implementationAddress: SMAV2_IMPL,
    salt,
    type: "SMA",
    ownerAddress: getAddress(eoaAddress),
  }));

  function accountKitChainFor(key) {
    return CHAIN_MAP[key] ?? mainnet;
  }
}

/** The SingleSignerValidationModule address for a chain (session-key entity 1). */
export function ssvModuleAddress(chainKey) {
  return getDefaultSingleSignerValidationModuleAddress(CHAIN_MAP[chainKey] ?? mainnet);
}

// EntryPoint 0.7 hashing — the exact module the fork dry run used, so browser
// personal_sign signatures verify against the same digest the server computes.
// @aa-sdk/core does not export the entrypoint submodule, so resolve the dist
// file directly (same file the dry run imported by relative path).
import { fileURLToPath } from "url";
import { dirname as _dirname, resolve as _resolve } from "path";
const _here = _dirname(fileURLToPath(import.meta.url));
const ep07 = (await import(/* webpackIgnore: true */ "file://" + _here + "/node_modules/@aa-sdk/core/dist/esm/entrypoint/0.7.js")).default;
export const ENTRY_POINT_V7 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

/**
 * The EIP-191 digest the wallet must sign for a UserOperation (what
 * handleOps will recover). `userOp` takes hex-string gas fields exactly as
 * the grant/move-out APIs emit them. Browser flow: personal_sign(digest) →
 * the returned 65-byte sig is packed with packUOSignature ("0xFF00"+sig).
 * Verified end-to-end on the 2026-09-20 mainnet fork (both UO legs).
 */
export function userOpDigest(chainKey, userOp) {
  return ep07.getUserOperationHash(
    {
      sender: userOp.sender,
      nonce: userOp.nonce,
      initCode: userOp.initCode ?? "0x",
      callData: userOp.callData,
      verificationGasLimit: userOp.verificationGasLimit,
      callGasLimit: userOp.callGasLimit,
      maxFeePerGas: userOp.maxFeePerGas,
      maxPriorityFeePerGas: userOp.maxPriorityFeePerGas,
      preVerificationGas: userOp.preVerificationGas,
      paymasterAndData: userOp.paymasterAndData ?? "0x",
    },
    ENTRY_POINT_V7,
    CHAIN_MAP[chainKey]?.id ?? 1
  );
}

/** Pack a browser personal_sign signature into the SMA UO signature format. */
export function packUOSignature(validationSignature) {
  // normalize v: some wallets return 0/1 instead of 27/28
  let sig = validationSignature;
  if (/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    const v = parseInt(sig.slice(-2), 16);
    if (v === 0 || v === 1) sig = sig.slice(0, -2) + (v + 27).toString(16).padStart(2, "0");
  }
  return concat(["0xFF", "0x00", sig]);
}

// Robinhood 4663 — same definition rangedesk uses (Alchemy supports the chain
// even though VultiSig does not; AA is chain-agnostic via this definition).
const robinhood = defineAlchemyChain({
  chain: {
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
    blockExplorers: {
      default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
    },
  },
  rpcBaseUrl: "https://robinhood-mainnet.g.alchemy.com/v2",
});

const CHAIN_MAP = { ethereum: mainnet, base, robinhood };

/** ETH that must stay in the SCW so the EntryPoint can take prefund. */
export function gasReserveWei(chainKey) {
  return chainKey === "ethereum" ? 800_000_000_000_000n : 20_000_000_000_000n; // 0.0008 / 0.00002
}

/**
 * Translate raw bundler/UserOperation errors into operator-readable text.
 * Same shape as rangedesk's explainUserOpError — AA23/AA25/prefund all mean
 * "the account ran out of gas the EntryPoint can claim".
 */
export function explainUserOpError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/already|exist/i.test(msg)) return "This wallet is already on-chain.";
  if (/AA23|AA25|AA31|AA33|AA34|prefund|reverted/i.test(msg)) {
    return "UserOperation reverted. The EntryPoint takes gas out of the smart wallet first — keep more ETH in it (reserve ≈ 0.0008 ETH) and try a smaller amount.";
  }
  return msg;
}

/** Resolve the Account Kit chain object for a chainKey from chains.mjs. */
function accountKitChain(chainKey) {
  const chain = CHAIN_MAP[chainKey];
  if (!chain) throw new Error(`smart-account signing not configured for chain "${chainKey}" (supported: ethereum, base, robinhood)`);
  return chain;
}

/** viem WalletClient for a user's session key (always passed explicitly). */
function sessionKeyWalletClient(chainKey, sessionKey) {
  const dep = getChain(chainKey);
  const sk = sessionKey?.trim();
  if (!sk) throw new Error("no session key for this wallet — automation is not granted (open the wallet slideout → Enable automated trading)");
  const account = privateKeyToAccount(sk.startsWith("0x") ? sk : "0x" + sk);
  return createWalletClient({ account, chain: dep.viemChain, transport: http(dep.httpRpc()) });
}

/** Cached clients per chain + session key + SCW. */
const _clients = new Map();

/** Drop cached AA clients (after a grant or key change). */
export function invalidateSmartAccountClient(chainKey = "ethereum", sessionKey = null) {
  for (const k of [..._clients.keys()]) {
    if (!k.startsWith(chainKey + ":")) continue;
    if (!sessionKey || k.startsWith(chainKey + ":" + sessionKey + ":")) _clients.delete(k);
  }
}

/**
 * AA client for a v2 wallet: SMA pinned to the user's EOA-owned SCW
 * (accountAddress = registry SCW), session key signing as ENTITY 1.
 * Both arguments are REQUIRED — there is no derive-from-key fallback anymore
 * (that path produced orphan LightAccount addresses: AA13, 2026-09-20).
 */
export async function getSmartAccountClient(chainKey = "ethereum", { sessionKey = null, scwAddress = null } = {}) {
  if (!scwAddress) throw new Error("getSmartAccountClient: scwAddress required (v2 wallets only — v1 derivation was removed)");
  if (!sessionKey) throw new Error("getSmartAccountClient: sessionKey required — automation is not granted for this wallet");
  const cacheKey = chainKey + ":" + sessionKey + ":" + getAddress(scwAddress);
  if (_clients.has(cacheKey)) return _clients.get(cacheKey);
  const p = (async () => {
    const signer = new WalletClientSigner(sessionKeyWalletClient(chainKey, sessionKey), "session-key");
    const { createModularAccountV2Client } = await import("@account-kit/smart-contracts");
    return createModularAccountV2Client({
      chain: accountKitChain(chainKey),
      transport: alchemy({ apiKey: requireAlchemyKey() }),
      signer,
      accountAddress: getAddress(scwAddress),
      signerEntity: { entityId: 1, isGlobalValidation: false },
    });
  })();
  p.catch(() => _clients.delete(cacheKey));
  _clients.set(cacheKey, p);
  return p;
}

function requireAlchemyKey() {
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (!key) throw new Error("ALCHEMY_API_KEY required for smart-account signing (bundler + RPC)");
  return key;
}

/**
 * The signer object handed to trade code. `address` is the user's SCW (the
 * registry address), never the session key's EOA — wallet-position scans,
 * approvals, and trade rows all read it.
 */
export async function buildSmartAccountSigner(chainKey = "ethereum", { sessionKey, scwAddress } = {}) {
  const dep = getChain(chainKey);
  const client = await getSmartAccountClient(chainKey, { sessionKey, scwAddress });
  const address = getAddress(client.account.address);
  if (address.toLowerCase() !== getAddress(scwAddress).toLowerCase()) {
    throw new Error(`smart-account client resolved ${address} but the registry wallet is ${scwAddress} — refusing to sign`);
  }
  const publicClient = createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc()) });
  console.log(`[signer] smart wallet ${address} (entity-1 session key) on ${dep.name}`);
  return {
    kind: "smart-account",
    address,
    async getEthBalanceWei() {
      return publicClient.getBalance({ address });
    },
    async callContract({ address: contractAddress, abi, functionName, args, value }) {
      // Gas fields from wrapSignerGas are deliberately IGNORED: UserOperation
      // gas is estimated by the bundler middleware.
      //
      // callGasLimit × 1.5 (2026-09-24): the bundler's estimate is a
      // point-in-time simulation, but swap gas depends on pool state (ticks
      // crossed, hook bookkeeping) at INCLUSION time. Live case: an IMD sell
      // through the hooked pool was estimated at 299,914 while the same call
      // needed ~300k+ once mined — it ran out of gas inside the hook's
      // afterSwap (v4 HookCallFailed 0xa9e35b2f). Replaying that exact op at
      // its pre-state: 299,914 reverts, 399,914 succeeds. Unused call gas is
      // not charged beyond the EntryPoint's small penalty, so the headroom is
      // cheap insurance.
      const data = encodeFunctionData({ abi, functionName, args });
      const { hash } = await client.sendUserOperation({
        uo: { target: contractAddress, data, value: value ?? 0n },
        overrides: { callGasLimit: { multiplier: 1.5 } },
      });
      const txHash = await client.waitForUserOperationTransaction({ hash });
      // A UserOperation can REVERT inside a bundle transaction that itself
      // succeeds — receipt.status is the BUNDLE's status, not ours. Read the
      // EntryPoint's UserOperationEvent for THIS userOpHash and throw on
      // success=false, so every caller (sniper, exit, dip, autosell) sees a
      // failed trade as a failure. (2026-09-24: sell 0xe140af81… reverted in
      // the hook but was recorded "ok" with 0.0025 ETH proceeds.)
      await assertUserOpSucceeded(publicClient, txHash, hash);
      return txHash;
    },
  };
}

const USER_OP_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const USER_OP_REVERT_REASON = "0x1c4fada7374c0a9ee8841fc38afe82932dc0f8e69012e927f061a8bae611a201";

/** Throw when the UserOperation `userOpHash` inside bundle tx `txHash` reverted. */
export async function assertUserOpSucceeded(publicClient, txHash, userOpHash) {
  const rc = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const want = String(userOpHash).toLowerCase();
  const ev = rc.logs.find((l) => l.topics?.[0] === USER_OP_EVENT && String(l.topics[1]).toLowerCase() === want);
  if (!ev) return; // not found (non-standard bundle) — fall back to bundle status checks downstream
  const success = BigInt("0x" + ev.data.slice(2 + 64, 2 + 128)) === 1n;
  if (success) return;
  const rr = rc.logs.find((l) => l.topics?.[0] === USER_OP_REVERT_REASON && String(l.topics[1]).toLowerCase() === want);
  let reason = "";
  if (rr) {
    const hex = rr.data;
    if (hex.includes("a9e35b2f")) reason = " — pool hook call failed (HookCallFailed)";
    else if (hex.includes("08c379a0")) reason = " — " + (hex.match(/08c379a0.{128}(.*)/)?.[1] ? "reverted with a reason string" : "reverted");
    else reason = " — revert data " + hex.slice(0, 74) + "…";
  }
  const err = new Error(`smart-wallet transaction reverted on-chain (tx ${txHash})${reason}`);
  err.txHash = txHash;
  throw err;
}
