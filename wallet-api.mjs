/**
 * wallet-api.mjs — GET /api/wallet handler.
 * Multi-chain ETH + dollar-token balances for the wallet slideout.
 *
 * Balance source (2026-09-19 — post auth-gate): the LOGGED-IN user's own
 * address — identity = wallet address (auth.mjs), so no separate "connected
 * wallet" concept exists anymore. Falls back to the configured signer
 * (legacy vault/raw key) only for anonymous/system calls, preserving
 * headless behavior.
 */
import { CHAIN_KEYS, getChain, getEthUsdPriceFor } from "./chains.mjs";
import { getErc20Balance, getImdPerEth } from "./dip-swap.mjs";
import { getDipWatchers } from "./db.mjs";
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
 * @param {(userId?: string|null) => Promise<boolean>} opts.isSignerConfigured
 * @param {(data: any, status?: number) => void} opts.json
 * @param {string|null} opts.userId - the authenticated session address, or null
 */
export async function walletApiHandler({ isSignerConfigured, json, userId = null }) {
  try {
    // The logged-in user's own address takes precedence; the configured signer
    // is the legacy fallback for anonymous/system calls. Balances are
    // READ-ONLY for that address — no key material involved.
    const readAddress = userId || null;   // null → per-chain signer below
    if (!readAddress && !(await isSignerConfigured(userId))) {
      return json({ ok: false, error: "no wallet connected" });
    }

    const results = await Promise.allSettled(CHAIN_META.map(async ({ key }) => {
      const dep = getChain(key);
      // Total-holdings reads (2026-09-20): sum ALL of the user's wallets per
      // chain — registry SCW (app-signed trades) + the login/browser EOA
      // (launchpad buys) — matching what refreshPositions() does for token
      // rows. A single-address read understated the slideout total whenever
      // funds sat on the other side of the custody boundary. The smart-wallet
      // card still shows the SCW's own balances separately.
      let addresses;
      if (readAddress) {
        const { resolveUserReadWallets } = await import("./smart-wallet-api.mjs");
        addresses = await resolveUserReadWallets(readAddress, key);
      } else {
        // Legacy fallback: resolve the CONNECTED-layer wallet (vault/raw key),
        // never the AA smart account — the SCW has its own card in the UI and
        // is not "the user's wallet". invalidateSigner avoids serving a cached
        // AA signer under the current env snapshot.
        const { invalidateSigner, resolveSigner } = await import("./signer.mjs");
        const prev = process.env.SMART_ACCOUNT_ACTIVE;
        process.env.SMART_ACCOUNT_ACTIVE = "false";
        invalidateSigner(key);
        try {
          const signer = await resolveSigner(key);
          addresses = [signer.address];
        } finally {
          process.env.SMART_ACCOUNT_ACTIVE = prev;
          invalidateSigner(key);
        }
      }
      const client = createPublicClient({ chain: dep.viemChain, transport: (await import("viem")).http(dep.httpRpc()) });
      const [ethWei, ethPrice, ...tokenRaws] = await Promise.all([
        Promise.all(addresses.map((a) => client.getBalance({ address: a }).catch(() => 0n))),
        getEthUsdPriceFor(key),
        ...addresses.map((a) => getErc20Balance(dep.dollar, a, key).catch(() => null)),
        // IMD balance (ethereum only today) — non-fatal when absent/unreadable.
        ...(dep.imdToken ? addresses.map((a) => getErc20Balance(dep.imdToken, a, key).catch(() => 0n)) : []),
      ]);
      const ethBalance = ethWei.reduce((s, w) => s + Number(w ?? 0n), 0) / 1e18;
      const dollarCount = addresses.length;
      const dollarRawParts = tokenRaws.slice(0, dollarCount);
      const imdRawParts = tokenRaws.slice(dollarCount);
      const sumRaw = (parts) => parts.reduce((s, r) => s + (r != null ? r : 0n), 0n);
      const dollarRaw = tokenRaws.length ? sumRaw(dollarRawParts) : null;
      const imdBalance = dep.imdToken ? Number(sumRaw(imdRawParts)) / 1e18 : null;
      return {
        ethBalance,
        ethUsd: ethBalance * ethPrice,
        dollarBalance: dollarRaw != null ? Number(dollarRaw) / (10 ** dep.dollarDecimals) : null,
        imdBalance,
      };
    }));

    const ethChains = [], usdChains = [], imdChains = [];
    let ethTotal = 0, ethTotalUsd = 0, usdTotalUsd = 0, imdTotal = 0;
    results.forEach((r, i) => {
      const meta = CHAIN_META[i];
      const err = r.status === "rejected" ? (r.reason?.message?.slice(0, 60) || "unavailable") : null;
      const bal = r.status === "fulfilled" ? r.value : { ethBalance: null, ethUsd: null, dollarBalance: null, imdBalance: null };
      ethChains.push({ name: meta.name, initials: meta.initials, color: meta.color, balance: bal.ethBalance, balanceUsd: bal.ethUsd, error: err });
      usdChains.push({ name: meta.name, initials: meta.initials, color: meta.color, symbol: meta.dollarSymbol, balance: bal.dollarBalance, balanceUsd: bal.dollarBalance, error: err ?? (bal.dollarBalance == null ? "balanceOf failed" : null) });
      // IMD rows only for chains that have the token configured (a null balance
      // on an IMD-less chain would just be noise). meta.key is this chain's key.
      if (bal.imdBalance != null) {
        imdChains.push({ name: meta.name, initials: meta.initials, color: meta.color, symbol: getChain(meta.key).imdSymbol || "IMD", balance: bal.imdBalance, error: err });
        imdTotal += bal.imdBalance ?? 0;
      }
      ethTotal += bal.ethBalance ?? 0; ethTotalUsd += bal.ethUsd ?? 0; usdTotalUsd += bal.dollarBalance ?? 0;
    });

    // Watched tokens from the /tokens table — position snapshots (balance,
    // USD value, price) are persisted by computeWalletPosition() and refreshed
    // by the watcher/dashboard, so reading them here costs no RPC calls.
    const tokens = getDipWatchers(userId)
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

    // IMD price for the slideout header/row display (ETH/IMD pool × ETH/USD).
    const imdPerEth = await getImdPerEth("ethereum").catch(() => 0);
    const imdUsd = imdPerEth > 0 ? (await getEthUsdPriceFor("ethereum").catch(() => 0)) / imdPerEth : 0;

    return json({
      ok: true,
      walletAddress: readAddress || undefined,     // the wallet these balances describe
      walletSource: readAddress ? "session" : "signer",
      eth: { total: ethTotal, totalUsd: ethTotalUsd, chains: ethChains },
      usd: { totalUsd: usdTotalUsd, symbol: usdChains.some(c => c.symbol === "USDG") ? "USD" : "USDC", chains: usdChains },
      imd: imdChains.length ? { total: imdTotal, totalUsd: imdTotal * imdUsd, perEth: imdPerEth, chains: imdChains } : null,
      tokens,
      totalUsd: ethTotalUsd + usdTotalUsd + tokensUsd,
    });
  } catch (e) {
    return json({ ok: false, error: e.message });
  }
}

// lazy import to avoid a cycle at module init (signer.mjs pulls chains)
import { resolveSigner } from "./signer.mjs";
