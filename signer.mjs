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
  // mode is part of the cache key (2026-09-21 fix): it used to be
  // `${userId}:${chainKey}` alone, so a resolved-or-FAILED signer from
  // BEFORE a mode switch kept being returned after the switch — Settings'
  // mode toggle never invalidated it, and dip-watcher.mjs/dashboard.mjs
  // each cache independently anyway (separate processes). Baking mode into
  // the key makes a mode switch naturally resolve fresh instead of relying
  // on an invalidation call that didn't exist. A rejected resolution is
  // also evicted below instead of poisoning the cache for the process's
  // lifetime (found live: a stale rejected "AA_SESSION_KEY not set" kept
  // failing every retry until a manual restart).
  const cacheKey = `${userId}:${chainKey}:${mode}`;
  if (_signerPromises.has(cacheKey)) return _signerPromises.get(cacheKey);

  const p = (async () => {
    if (mode === "copilot") {
      const { buildCoPilotSignerFor } = await import("./copilot.mjs");
      return buildCoPilotSignerFor(userId, chainKey);
    }
    if (mode === "autonomy") {
      // v2 only: the user's EOA-owned SCW from the registry, signed by the
      // granted entity-1 session key. No derivation, no users-table fallback.
      const { getWalletRecord, isV2Record } = await import("./smart-wallet-registry.mjs");
      const rec = getWalletRecord(userId);
      if (!rec || !isV2Record(rec)) throw new Error(`user ${userId.slice(0, 6)}…${userId.slice(-4)} has no v2 smart wallet — reconnect the wallet in the header`);
      // Key presence is the gate (unchanged behavior): a "pending" grantStatus
      // can still have a working on-chain operator — the bundler is the judge.
      if (!rec.sessionKeyEnc) {
        throw new Error(`user ${userId.slice(0, 6)}…${userId.slice(-4)} is in autonomy mode but automation is not granted — open the wallet slideout → Enable automated trading`);
      }
      const { resolveUserSessionKeyAsync } = await import("./smart-wallet-api.mjs");
      const sessionKey = await resolveUserSessionKeyAsync(userId);
      if (!sessionKey) throw new Error(`session key for ${userId.slice(0, 6)}…${userId.slice(-4)} is missing from the registry`);
      const { buildSmartAccountSigner } = await import("./smart-account.mjs");
      return buildSmartAccountSigner(chainKey, { sessionKey, scwAddress: rec.scwAddress });
    }
    throw new Error(`unknown signer_mode "${mode}"`);
  })();
  // Evict on failure — a rejected resolution (missing session key, RPC
  // hiccup) must not poison this cache key for the
  // rest of the process's life; the next call should get a fresh attempt.
  p.catch(() => _signerPromises.delete(cacheKey));
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
 * VAULT_ACTIVE / AGENT_PRIVATE_KEY hot-updates).
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

  // (SMART_ACCOUNT_ACTIVE global signer removed with v1, 2026-09-24: smart
  // wallets are strictly per-user — resolveSignerUser(userId). There is no
  // system-wide smart account.)

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
