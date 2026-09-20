/**
 * smart-account.mjs — Alchemy LightAccount v2 signer backend (server-side)
 *
 * NOTE 2026-09-17: switched from ModularAccountV2 to LightAccount v2.
 * MA v2's first-UO deploy path fails AA23/UnrecognizedFunction(0x0) on mainnet
 * AND sepolia with SDK 4.88.5 (reproduced with the SDK's own flow + fresh key —
 * an Alchemy contract/SDK drift in MA v2's plugin init, not our config).
 * LightAccount builds cleanly through the same middleware (factory
 * 0x0000000000400cdfef5e2714e63d8040b700bc24, EntryPoint 0.7), is Alchemy's
 * flagship account, and fits Phase 1 exactly: the burner session key owns the
 * account directly. If Phase 2 session-key policies are still wanted, they can
 * ride on LightAccount's plugin system or MA v2 once Alchemy fixes the drift.
 *
 * The VPS never holds any owner key beyond the burner session key it signs with.
 * See docs/smart-account-signer.md for the full plan and docs/vps-deploy.md §0
 * for why this replaces the vault-file model on a VPS.
 *
 * Interface contract (must match signer.mjs exactly):
 *   { kind, address, getEthBalanceWei(), callContract({ address, abi, functionName, args, value }) → txHash }
 * callContract RESOLVES to the UserOperation's inner transaction hash, so all
 * downstream waitForTransactionReceipt / assertTxSucceeded / gas-ledger code
 * works unchanged.
 */
import { WalletClientSigner } from "@aa-sdk/core";
import { alchemy, mainnet, base, defineAlchemyChain } from "@account-kit/infra";
import { createLightAccountClient, createMultiOwnerLightAccountAlchemyClient, predictModularAccountV2Address } from "@account-kit/smart-contracts";
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

/**
 * Build the viem WalletClient for a session key (explicit key param or env).
 *
 * Per-connected-wallet model (2026-09-18): each connected wallet gets its OWN
 * session key + smart account (registry in smart-wallet-registry.mjs). The
 * active session key is the one bound to the currently connected wallet.
 */
function sessionKeyWalletClient(chainKey, sessionKeyOverride = null) {
  const dep = getChain(chainKey);
  const sk = (sessionKeyOverride ?? process.env.AA_SESSION_KEY)?.trim();
  if (!sk) throw new Error("AA_SESSION_KEY not set — cannot sign UserOperations");
  const account = privateKeyToAccount(sk.startsWith("0x") ? sk : "0x" + sk);
  return createWalletClient({
    account,
    chain: dep.viemChain,
    transport: http(dep.httpRpc()),
  });
}

/** Cached clients per chain+sessionKey — resolving the SCW address does an RPC round-trip. */
const _clients = new Map();

/** Drop the cached AA client (after changing AA_SESSION_KEY or the active wallet). */
export function invalidateSmartAccountClient(chainKey = "ethereum", sessionKey = null) {
  if (sessionKey) _clients.delete(chainKey + ":" + sessionKey);
  else for (const k of [..._clients.keys()]) if (k.startsWith(chainKey)) _clients.delete(k);
}

/**
 * Get the AA client for a specific session key (per-connected-wallet SCWs).
 * Without a key override, uses the active AA_SESSION_KEY (back-compat).
 */
/**
 * Get the AA client for a specific session key (per-connected-wallet SCWs).
 * Without a key override, uses the active AA_SESSION_KEY (back-compat).
 *
 * v2 wallets (2026-09-20): the SCW is the EOA-owned SMA from the registry, and
 * the session key is an ENTITY-1 operator (SingleSignerValidationModule) — so
 * build the client with createModularAccountV2Client, accountAddress = the
 * registry SCW, signerEntity = { entityId: 1, isGlobalValidation: false }.
 * The legacy path (MultiOwnerLightAccount derived FROM the key) is kept only
 * for v1 records — driving a v2 wallet through it sends UOs to an orphan
 * LightAccount address (AA13, found live 2026-09-20).
 */
export async function getSmartAccountClient(chainKey = "ethereum", { sessionKey = null, scwAddress = null } = {}) {
  const cacheKey = chainKey + ":" + (sessionKey ?? "default") + ":" + (scwAddress ?? "derive");
  if (_clients.has(cacheKey)) return _clients.get(cacheKey);
  const p = (async () => {
    const walletClient = sessionKeyWalletClient(chainKey, sessionKey);
    const signer = new WalletClientSigner(walletClient, "session-key");
    if (scwAddress) {
      // v2: SMA client pinned to the user's EOA-owned wallet, session key signs as entity 1
      const { createModularAccountV2Client } = await import("@account-kit/smart-contracts");
      const client = await createModularAccountV2Client({
        chain: accountKitChain(chainKey),
        transport: alchemy({ apiKey: requireAlchemyKey() }),
        signer,
        accountAddress: getAddress(scwAddress),
        signerEntity: { entityId: 1, isGlobalValidation: false },
      });
      return client;
    }
    // MultiOwnerLightAccount: supports transferOwnership / addOwner, so key
    // rotation ADDS a signer instead of orphaning the account + funds (the
    // single-owner LightAccount trap: regenerate → old key powerless → funds
    // invisible to the app). Old key stays authoritative until explicitly
    // demoted. Phase 2 on-chain spend caps tracked in docs/smart-account-signer.md.
    const client = await createMultiOwnerLightAccountAlchemyClient({
      chain: accountKitChain(chainKey),
      transport: alchemy({ apiKey: requireAlchemyKey() }),
      signer,
    });
    return client;
  })();
  _clients.set(cacheKey, p);
  return p;
}

function requireAlchemyKey() {
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (!key) throw new Error("ALCHEMY_API_KEY required for smart-account signing (bundler + RPC)");
  return key;
}

/**
 * The signer object handed to resolveSigner() consumers. `address` is the
 * SMART ACCOUNT address (counterfactual if undeployed), not the session key's
 * EOA — wallet-position scans, approvals, and trade rows all read it.
 * scwAddress: v2 wallets pass the registry SCW here so the client pins the
 * EOA-owned SMA and signs as entity-1 (see getSmartAccountClient).
 */
export async function buildSmartAccountSigner(chainKey = "ethereum", { sessionKey = null, scwAddress = null } = {}) {
  const dep = getChain(chainKey);
  // sessionKey override (Phase 2): per-user autonomy — the caller swaps env
  // AA_SESSION_KEY OR passes the user's stored key directly; the client cache
  // is keyed per session key so users never collide.
  const client = await getSmartAccountClient(chainKey, { sessionKey, scwAddress });
  const address = getAddress(client.account.address);
  const publicClient = createPublicClient({
    chain: dep.viemChain,
    transport: http(dep.httpRpc()),
  });

  console.log(`[signer] Using Alchemy smart account ${address} (session-key signer) on ${dep.name}`);

  return {
    kind: "smart-account",
    address,
    async getEthBalanceWei() {
      return publicClient.getBalance({ address });
    },
    async callContract({ address: contractAddress, abi, functionName, args, value }) {
      // Gas fields from wrapSignerGas are deliberately IGNORED: UserOperation
      // gas is estimated by the bundler middleware. (Accepted silently — the
      // sniper routes pass maxFeePerGas/maxPriorityFeePerGas today.)
      const data = encodeFunctionData({ abi, functionName, args });
      const uo = { target: contractAddress, data, value: value ?? 0n };
      const { hash } = await client.sendUserOperation({ uo });
      const txHash = await client.waitForUserOperationTransaction({ hash });
      return txHash;
    },
  };
}
