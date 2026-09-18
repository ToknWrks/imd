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

const _signerPromises = new Map();

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
}

async function _resolveSigner(chainKey = "ethereum") {
  const dep = getChain(chainKey);

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
