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
import { createLightAccountClient, createMultiOwnerLightAccountAlchemyClient } from "@account-kit/smart-contracts";
import { createWalletClient, createPublicClient, http, getAddress, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChain } from "./chains.mjs";

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
export async function getSmartAccountClient(chainKey = "ethereum", { sessionKey = null } = {}) {
  const cacheKey = chainKey + ":" + (sessionKey ?? "default");
  if (_clients.has(cacheKey)) return _clients.get(cacheKey);
  const p = (async () => {
    const walletClient = sessionKeyWalletClient(chainKey, sessionKey);
    const signer = new WalletClientSigner(walletClient, "session-key");
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
 */
export async function buildSmartAccountSigner(chainKey = "ethereum") {
  const dep = getChain(chainKey);
  const client = await getSmartAccountClient(chainKey);
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
