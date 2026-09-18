/**
 * wallet-api.mjs — GET /api/wallet handler.
 * Multi-chain ETH + dollar-token balances for the wallet slideout.
 *
 * Balance source (2026-09-17 wallet-connect migration): the CONNECTED wallet
 * (header session, CONNECTED_WALLET env) when set — that's "the user's wallet"
 * in the connect-wallet model. Falls back to the configured signer (legacy
 * vault/raw key) when no browser wallet is connected, preserving headless
 * behavior.
 */
import { CHAIN_KEYS, getChain, getEthUsdPriceFor } from "./chains.mjs";
import { getErc20Balance } from "./dip-swap.mjs";
import { getDipWatchers } from "./db.mjs";
import { getConnectedWallet } from "./wallet-connect-store.mjs";
import { createPublicClient, http } from "viem";

/** Chain display metadata — names, colors, initials, dollar-token symbols. */
const CHAIN_META = CHAIN_KEYS.map((k) => {
  const dep = getChain(k);
  return {
    key: k,
    name: dep.name,
    initials: dep.name === "Robinhood Chain" ? "RH" : dep.name.slice(0, 2).toUpperCase(),
    color: { ethereum: "#627eea", robinhood: "#00D54B", base: "#0052FF" }[k] || "#444",
    dollarSymbol: dep.dollarDecimals === 6 ? (k === "robinhood" ? "USDG" : "USDC") : "USD",
  };
});

/**
 * @param {object} opts
 * @param {() => Promise<boolean>} opts.isSignerConfigured
 * @param {(data: any, status?: number) => void} opts.json
 */
export async function walletApiHandler({ isSignerConfigured, json }) {
  try {
    // The connected (browser) wallet takes precedence; the configured signer is
    // the legacy fallback. Balances are READ-ONLY for the connected wallet —
    // the address is all the server knows.
    const connected = getConnectedWallet();
    const readAddress = connected || null;   // null → per-chain signer below
    if (!connected && !(await isSignerConfigured())) {
      return json({ ok: false, error: "no wallet connected" });
    }

    const results = await Promise.allSettled(CHAIN_META.map(async ({ key }) => {
      const dep = getChain(key);
      let address = readAddress;
      if (!address) {
        // Legacy fallback: resolve the CONNECTED-layer wallet (vault/raw key),
        // never the AA smart account — the SCW has its own card in the UI and
        // is not "the user's wallet". invalidateSigner avoids serving a cached
        // AA signer under the current env snapshot.
        const { invalidateSigner } = await import("./signer.mjs");
        const prev = process.env.SMART_ACCOUNT_ACTIVE;
        process.env.SMART_ACCOUNT_ACTIVE = "false";
        invalidateSigner(key);
        try {
          const signer = await resolveSigner(key);
          address = signer.address;
        } finally {
          process.env.SMART_ACCOUNT_ACTIVE = prev;
          invalidateSigner(key);
        }
      }
      const [ethWei, ethPrice, dollarRaw] = await Promise.all([
        createPublicClient({ chain: dep.viemChain, transport: (await import("viem")).http(dep.httpRpc()) })
          .getBalance({ address }),
        getEthUsdPriceFor(key),
        getErc20Balance(dep.dollar, address, key).catch(() => null),
      ]);
      const ethBalance = Number(ethWei) / 1e18;
      return {
        ethBalance,
        ethUsd: ethBalance * ethPrice,
        dollarBalance: dollarRaw != null ? Number(dollarRaw) / (10 ** dep.dollarDecimals) : null,
      };
    }));

    const ethChains = [], usdChains = [];
    let ethTotal = 0, ethTotalUsd = 0, usdTotalUsd = 0;
    results.forEach((r, i) => {
      const meta = CHAIN_META[i];
      const err = r.status === "rejected" ? (r.reason?.message?.slice(0, 60) || "unavailable") : null;
      const bal = r.status === "fulfilled" ? r.value : { ethBalance: null, ethUsd: null, dollarBalance: null };
      ethChains.push({ name: meta.name, initials: meta.initials, color: meta.color, balance: bal.ethBalance, balanceUsd: bal.ethUsd, error: err });
      usdChains.push({ name: meta.name, initials: meta.initials, color: meta.color, symbol: meta.dollarSymbol, balance: bal.dollarBalance, balanceUsd: bal.dollarBalance, error: err ?? (bal.dollarBalance == null ? "balanceOf failed" : null) });
      ethTotal += bal.ethBalance ?? 0; ethTotalUsd += bal.ethUsd ?? 0; usdTotalUsd += bal.dollarBalance ?? 0;
    });

    // Watched tokens from the /tokens table — position snapshots (balance,
    // USD value, price) are persisted by computeWalletPosition() and refreshed
    // by the watcher/dashboard, so reading them here costs no RPC calls.
    const tokens = getDipWatchers()
      .filter((w) => w.wallet_balance != null)
      .map((w) => ({
        symbol: w.symbol,
        address: w.contract_address,
        chain: w.chain || "ethereum",
        chainName: (() => { try { return getChain(w.chain || "ethereum").name; } catch { return w.chain; } })(),
        balance: Number(w.wallet_balance),
        balanceUsd: w.wallet_balance_usd != null ? Number(w.wallet_balance_usd) : null,
        priceUsd: w.price_usd != null ? Number(w.price_usd) : null,
        costBasisUsd: w.cost_basis_usd != null ? Number(w.cost_basis_usd) : null,
        unrealizedPlUsd: w.unrealized_pl_usd != null ? Number(w.unrealized_pl_usd) : null,
        positionError: w.position_error || null,
      }));
    const tokensUsd = tokens.reduce((s, t) => s + (t.balanceUsd ?? 0), 0);

    return json({
      ok: true,
      walletAddress: readAddress || undefined,     // the wallet these balances describe
      walletSource: connected ? "connected" : "signer",
      eth: { total: ethTotal, totalUsd: ethTotalUsd, chains: ethChains },
      usd: { totalUsd: usdTotalUsd, symbol: usdChains.some(c => c.symbol === "USDG") ? "USD" : "USDC", chains: usdChains },
      tokens,
      totalUsd: ethTotalUsd + usdTotalUsd + tokensUsd,
    });
  } catch (e) {
    return json({ ok: false, error: e.message });
  }
}

// lazy import to avoid a cycle at module init (signer.mjs pulls chains)
import { resolveSigner } from "./signer.mjs";
