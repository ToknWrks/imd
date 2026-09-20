/**
 * signer.mjs
 *
 * Resolves the configured signer into one common interface, regardless of
 * whether it's a raw private key or a VultiSig MPC vault:
 *
 *   { address, getEthBalanceWei(), callContract({ address, abi, functionName, args, value }) }
 *
 * dip-swap.mjs and dip-watcher.mjs are written against this interface only —
 * they never need to know which signing backend is in use.
 */
import { createPublicClient, createWalletClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChain } from "./chains.mjs";

function getHttpRpcUrl(chainKey = "ethereum") {
  return getChain(chainKey).httpRpc();
}

const VAULT_CHAIN_NAMES = { ethereum: "Ethereum", base: "Base" };

// Signer cache — key: `${userId ?? "system"}:${chainKey}`. Per-user isolation
// (Phase 2): each user's autonomy-mode session key builds its own signer; the
// system signer (env config) lives under the "system" key. resolveSignerUser
// resolves a SPECIFIC user's signer; resolveSigner stays env-configured for
// backward compatibility (local single-user mode).
const _signerPromises = new Map();

// ── Per-user autonomy signer (Phase 2 multi-user) ───────────────────────────
/**
 * Resolve a specific USER's signer. Modes:
 *   - 'copilot'  → the co-pilot signer (browser wallet approves; no server key)
 *   - 'autonomy' → that user's own smart account, derived from THEIR encrypted
 *                  session key (users.mjs). Falls back to an error when unset.
 * 'system' matches the legacy env-driven behavior exactly.
 */
export async function resolveSignerUser(userId, chainKey = "ethereum") {
  if (!userId || userId === "system") return resolveSigner(chainKey);
  const { getUser } = await import("./users.mjs");
  const user = getUser(userId);
  if (!user) throw new Error(`unknown user ${userId}`);
  if (user.disabled === 1) throw new Error("account disabled");

  const mode = user.signer_mode || "copilot";
  const cacheKey = `${userId}:${chainKey}`;
  if (_signerPromises.has(cacheKey)) return _signerPromises.get(cacheKey);

  const p = (async () => {
    if (mode === "copilot") {
      const { buildCoPilotSignerFor } = await import("./copilot.mjs");
      return buildCoPilotSignerFor(userId, chainKey);
    }
    if (mode === "autonomy") {
      // Unified resolver (2026-09-18): registry first, users-table key as legacy
      // fallback — one wallet per user across slideout, settings, and signing.
      const { resolveUserSessionKeyAsync } = await import("./smart-wallet-api.mjs");
      const { getWalletRecord, isV2Record } = await import("./smart-wallet-registry.mjs");
      const sessionKey = await resolveUserSessionKeyAsync(userId);
      if (!sessionKey) throw new Error(`user ${userId.slice(0, 6)}…${userId.slice(-4)} has autonomy mode but no session key stored — connect your wallet in the header (or generate one in Settings)`);
      // v2: pin the client to the registry SCW (EOA-owned SMA, entity-1 signing).
      const rec = getWalletRecord(userId);
      const scwAddress = rec && isV2Record(rec) ? rec.scwAddress : null;
      // Per-user session key passed directly — no env swap needed; the client
      // cache in smart-account.mjs keys on the session key so users can't collide.
      const { buildSmartAccountSigner } = await import("./smart-account.mjs");
      return buildSmartAccountSigner(chainKey, { sessionKey, scwAddress });
    }
    throw new Error(`unknown signer_mode "${mode}"`);
  })();
  _signerPromises.set(cacheKey, p);
  return p;
}

/**
 * Signer for the Market Maker bot specifically. Uses MM_PRIVATE_KEY when set
 * (a dedicated MM hot wallet — keeps its inventory/ETH fully segregated from
 * the dip strategies), falling back to the shared AGENT_PRIVATE_KEY otherwise.
 * Memoized separately from resolveSigner so the two caches never collide.
 */
export async function resolveMmSigner(chainKey = "ethereum") {
  const cacheKey = `mm:${chainKey}`;
  if (_signerPromises.has(cacheKey)) return _signerPromises.get(cacheKey);
  const mmKey = process.env.MM_PRIVATE_KEY?.trim();
  if (mmKey) {
    // Build the raw-key signer directly (vault signing stays dip-watcher-only)
    // but reusing _resolveSigner's raw-key branch would also read MM_PRIVATE_KEY
    // if we set it — cleanest is a dedicated build with the same interface.
    const p = (async () => {
      const dep = getChain(chainKey);
      const account = privateKeyToAccount(mmKey.startsWith("0x") ? mmKey : "0x" + mmKey);
      const publicClient = createPublicClient({ chain: dep.viemChain, transport: http(getHttpRpcUrl(chainKey)) });
      const walletClient = createWalletClient({ account, chain: dep.viemChain, transport: http(getHttpRpcUrl(chainKey)) });
      console.log(`[signer] MM bot using dedicated wallet ${account.address} on ${dep.name}`);
      return {
        kind: "key",
        address: account.address,
        async getEthBalanceWei() {
          return publicClient.getBalance({ address: account.address });
        },
        async callContract({ address: contractAddress, abi, functionName, args, value, maxFeePerGas, maxPriorityFeePerGas }) {
          const fee = {};
          if (maxFeePerGas) fee.maxFeePerGas = maxFeePerGas;
          if (maxPriorityFeePerGas) fee.maxPriorityFeePerGas = maxPriorityFeePerGas;
          return walletClient.writeContract({ address: contractAddress, abi, functionName, args, value, account, chain: dep.viemChain, ...fee });
        },
      };
    })();
    _signerPromises.set(cacheKey, p);
    return p;
  }
  // No dedicated MM key — share the main signer (existing behavior).
  return resolveSigner(chainKey);
}

export async function resolveSigner(chainKey = "ethereum") {
  if (_signerPromises.has(chainKey)) return _signerPromises.get(chainKey);
  const p = _resolveSigner(chainKey);
  _signerPromises.set(chainKey, p);
  return p;
}

/**
 * Drop the cached signer for a chain (call after changing signer env vars —
 * SMART_ACCOUNT_ACTIVE / VAULT_ACTIVE / AGENT_PRIVATE_KEY hot-updates).
 */
export function invalidateSigner(chainKey = "ethereum") {
  _signerPromises.delete(chainKey);
  // Co-pilot signers cache the connected address — drop them on any invalidation
  // (mode toggle, CONNECTED_WALLET change) so the next resolve picks up state.
  import("./copilot.mjs").then((m) => m.invalidateCoPilotSigners()).catch(() => {});
}

async function _resolveSigner(chainKey = "ethereum") {
  const dep = getChain(chainKey);

  if (process.env.COPILOT_ACTIVE === "true") {
    // Co-pilot mode: the browser wallet signs every trade after an in-dashboard
    // approval prompt. callContract() enqueues a sign request and blocks — a
    // decline/timeout throws, which every engine's catch already handles
    // (reservation finalized, error row written, trade skipped).
    const { buildCoPilotSigner } = await import("./copilot.mjs");
    return buildCoPilotSigner(chainKey);
  }

  if (process.env.SMART_ACCOUNT_ACTIVE === "true") {
    // Alchemy Modular Account v2 via a VPS-held session key. callContract()
    // sends a UserOperation and resolves to the inner tx hash, so every
    // downstream receipt-wait/gas-ledger path works unchanged. See
    // smart-account.mjs + docs/smart-account-signer.md.
    if (chainKey !== "ethereum" && chainKey !== "base" && chainKey !== "robinhood") {
      throw new Error(`smart-account signing not supported on ${dep.name}`);
    }
    const { buildSmartAccountSigner } = await import("./smart-account.mjs");
    return buildSmartAccountSigner(chainKey);
  }

  if (process.env.VAULT_ACTIVE === "true") {
    const vaultChainName = VAULT_CHAIN_NAMES[chainKey];
    if (!vaultChainName) throw new Error(`vault signing is not supported on ${dep.name} — use AGENT_PRIVATE_KEY instead`);
    const { loadVault } = await import("./vault.mjs");
    const { Chain } = await import("@vultisig/sdk");
    const vaultChain = Chain[vaultChainName];
    const vault = await loadVault({ vultPath: process.env.VULT_FILE_PATH, password: process.env.VULTISIG_PASS });
    const address = getAddress(await vault.address(vaultChain));

    console.log(`[signer] Using VultiSig vault ${address} on ${dep.name}`);

    return {
      kind: "vault",
      address,
      async getEthBalanceWei() {
        const bal = await vault.balance(vaultChain);
        return BigInt(bal.amount);
      },
      async callContract({ address: contractAddress, abi, functionName, args, value, maxFeePerGas, maxPriorityFeePerGas }) {
        const res = await vault.contractCall({
          chain: vaultChain, contractAddress, abi, functionName, args, value,
        });
        return res.txHash;
      },
    };
  }

  const pk = process.env.AGENT_PRIVATE_KEY?.trim();
  if (!pk) throw new Error("No signer configured — set AGENT_PRIVATE_KEY or VAULT_ACTIVE=true in .env");

  const account = privateKeyToAccount(pk);
  const rpcUrl = getHttpRpcUrl(chainKey);
  const publicClient = createPublicClient({ chain: dep.viemChain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: dep.viemChain, transport: http(rpcUrl) });

  console.log(`[signer] Using wallet ${account.address} on ${dep.name}`);

  return {
    kind: "key",
    address: account.address,
    async getEthBalanceWei() {
      return publicClient.getBalance({ address: account.address });
    },
    async callContract({ address: contractAddress, abi, functionName, args, value, maxFeePerGas, maxPriorityFeePerGas }) {
      const fee = {};
      if (maxFeePerGas) fee.maxFeePerGas = maxFeePerGas;
      if (maxPriorityFeePerGas) fee.maxPriorityFeePerGas = maxPriorityFeePerGas;
      return walletClient.writeContract({ address: contractAddress, abi, functionName, args, value, account, chain: dep.viemChain, ...fee });
    },
  };
}
