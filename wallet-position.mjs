/**
 * wallet-position.mjs — reconstructs a wallet's live balance, USD value, and
 * weighted-average cost basis for a token entirely from on-chain data.
 *
 * Approach: only three assets matter — the token itself, USDC, and ETH
 * (native or wrapped — a WETH transfer counts the same as native ETH).
 *   1. Live balance via balanceOf + live spot price (pool slot0 x Chainlink ETH/USD)
 *   2. Every TOKEN/USDC/WETH transfer the wallet has ever sent/received (via
 *      Alchemy's alchemy_getAssetTransfers), grouped by transaction hash
 *   3. For each transaction where the wallet received the token, the actual
 *      USDC and/or ETH it paid *in that same transaction* (USDC or WETH
 *      transferred out, or — if neither appears — the transaction's native
 *      ETH value) — real dollars spent, not a modeled market price. ETH
 *      amounts are converted to USD using the on-chain USDC/WETH pool's
 *      historical price at that block (no third-party price-history API).
 *   4. A weighted-average-cost ledger: each priced acquisition adds to the
 *      average-cost pool; each disposal (token sent out) proportionally
 *      reduces it. Disposals also accumulate REALIZED P/L — the actual
 *      proceeds received in that same tx (USDC/WETH sent to the wallet, or
 *      native ETH value), minus the proportional average cost removed.
 *      Acquisitions with no USDC/ETH counter-transfer in the same tx
 *      (airdrops, transfers from another wallet, swaps through some other
 *      token) are conservatively excluded — their cost is unknown.
 */
import { formatUnits } from "viem";
import {
  findBestPool, findBestV4Pool, findBestV3DollarPool, getTokenSpotPriceEth, getV4SpotPriceEth,
  getCurveCoinState, getImdPerEth,
  getV4SpotPriceUsd, getV3DollarSpotPriceUsd, getEthUsdPriceAtBlock, getEthUsdPrice,
  getErc20Balance, getTxEthValue, getTxDeliveredEth, resolvePoolOverride, isDollarQuotePool,
} from "./dip-swap.mjs";
import { longTokenPriceUsd } from "./long-platform.mjs";

const ETH_ADDRESS_ZERO = "0x0000000000000000000000000000000000000000";
import { getChain } from "./chains.mjs";

const MAX_TRANSFERS = 1000; // per direction — bounds worst-case latency for very active wallets
const CONCURRENCY = 8;

const ALCHEMY_SUBDOMAIN = { ethereum: "eth-mainnet", robinhood: "robinhood-mainnet", base: "base-mainnet" };

function alchemyUrl(chainKey = "ethereum") {
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (!key) throw new Error("Alchemy API key required (Settings → RPC) to reconstruct wallet cost basis");
  return `https://${ALCHEMY_SUBDOMAIN[chainKey]}.g.alchemy.com/v2/${key}`;
}

/** TOKEN + dollar + WETH erc20 transfers only — no broad ETH-history scan (see file header). */
async function fetchTransfers({ contractAddress, walletAddress, direction, chainKey = "ethereum" }) {
  const dep = getChain(chainKey);
  const url = alchemyUrl(chainKey);
  const addressKey = direction === "in" ? "toAddress" : "fromAddress";
  let transfers = [];
  let pageKey;
  do {
    const params = [{
      fromBlock: "0x0", toBlock: "latest", category: ["erc20"], withMetadata: false,
      order: "asc", maxCount: "0x3e8", contractAddresses: [contractAddress, dep.dollar, dep.weth],
      [addressKey]: walletAddress, ...(pageKey ? { pageKey } : {}),
    }];
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`alchemy_getAssetTransfers: ${body.error.message}`);
    transfers = transfers.concat(body.result.transfers.map((t) => ({ ...t, dir: direction })));
    pageKey = body.result.pageKey;
  } while (pageKey && transfers.length < MAX_TRANSFERS);
  return transfers.slice(0, MAX_TRANSFERS);
}

/** Retries a flaky RPC call — Robinhood chain's public/archive endpoints are
 *  rate-limited and occasionally drop requests (see CLAUDE.md). Without this,
 *  a single transient failure silently zeroes out that block's price and can
 *  make cost basis look like it doesn't exist. */
async function retry(fn, attempts = 3, delayMs = 400) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1))); }
  }
  throw lastErr;
}

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function rawAmount(t, decimals) {
  return Number(formatUnits(BigInt(t.rawContract?.value ?? "0x0"), decimals));
}

/**
 * @returns {Promise<{
 *   balance: number, balanceUsd: number, priceUsd: number,
 *   costBasisUsd: number|null, totalCostBasisUsd: number|null,
 *   unrealizedPlUsd: number|null, unrealizedPlPct: number|null,
 *   realizedPlUsd: number, transferCount: number, truncated: boolean,
 * }>}
 */
export async function computeWalletPosition({ contractAddress, decimals, walletAddress, walletAddresses = null, chainKey = "ethereum", poolOverride = null }) {
  const dep = getChain(chainKey);
  const tokenLower = contractAddress.toLowerCase();
  const dollarLower = dep.dollar.toLowerCase();
  // A manual pool override (dip_watchers.pool_address) is resolved on-chain,
  // same as dip-watcher.mjs, and bypasses Dexscreener entirely — required on
  // chains Dexscreener doesn't index (e.g. Robinhood has no V3 factory either,
  // so auto-discovery has no fallback there).
  const override = await resolvePoolOverride(contractAddress, poolOverride, chainKey);
  // V4-first, same as dip-watcher.mjs/zooch — V3 may not exist on this chain.
  const v4Pool = override ? (override.kind === "v4" ? override : null) : await findBestV4Pool(contractAddress, chainKey).catch(() => null);
  // findBestPool throws "No WETH pool found" when no V3 pool exists — curve
  // coins have NO AMM pools at all, so catch and fall through to the curve branch.
  let v3Pool = override ? (override.kind === "v3" ? override : null) : (v4Pool ? null : await findBestPool(contractAddress, chainKey).catch(() => null));
  // Same blind spot buyToken() had: findBestPool only searches WETH pools, and
  // a token like VULT can have all-WETH pools empty while its dollar pool is
  // deep. An empty WETH pool's slot0 price is garbage — prefer the dollar pool.
  if (!v4Pool && !override && v3Pool && v3Pool.liquidity === 0n) {
    const dollarPool = await findBestV3DollarPool(contractAddress, chainKey).catch(() => null);
    if (dollarPool) v3Pool = dollarPool;
  }
  // Curve coin (IMD launchpad): no AMM pool exists at all. Price comes from
  // the curve (indexer reserves → IMD/coin) × live IMD/ETH × ETH/USD; the
  // shared balance/transfer cost-basis math below runs unchanged with that price.
  let curvePriceUsd = null;
  if (!v4Pool && !v3Pool) {
    const curve = await getCurveCoinState(contractAddress, chainKey).catch(() => null);
    if (!curve) throw new Error(`no pool resolved for ${contractAddress} on ${dep.name} — set a manual pool override`);
    const [imdPerEth, ethUsd0] = await Promise.all([
      getImdPerEth(chainKey).catch(() => 0),
      getEthUsdPrice(chainKey).catch(() => 0),
    ]);
    if (!imdPerEth || !ethUsd0) throw new Error(`curve coin ${contractAddress}: can't price IMD (ETH/IMD pool unavailable)`);
    const priceImd = Number(curve.virtualImd) / Number(curve.virtualCoin);
    curvePriceUsd = (priceImd / imdPerEth) * ethUsd0;   // IMD/coin ÷ IMD/ETH = ETH/coin → USD
  }


  const isDollarQuote = v4Pool
    ? isDollarQuotePool(v4Pool, contractAddress, chainKey)
    : v3Pool && v3Pool.token0 && v3Pool.token1 && (v3Pool.token0.toLowerCase() === dep.dollar.toLowerCase() || v3Pool.token1.toLowerCase() === dep.dollar.toLowerCase());
  // Stock-paired V4 pool (LONG platform, e.g. ATLANTIS/MU): the quote asset is
  // neither ETH/WETH nor the dollar token — slot0 "eth price" would be garbage.
  const otherCurrency = v4Pool
    ? (v4Pool.poolKey.currency0.toLowerCase() === tokenLower ? v4Pool.poolKey.currency1 : v4Pool.poolKey.currency0)
    : null;
  const isStockQuote = !!v4Pool && !isDollarQuote && !!otherCurrency
    && otherCurrency.toLowerCase() !== ETH_ADDRESS_ZERO
    && otherCurrency.toLowerCase() !== dep.weth.toLowerCase();
  const wallets = walletAddresses ?? (walletAddress ? [walletAddress] : []);
  const [balancesRaw, poolPrice, ethUsd] = await Promise.all([
    // Sum the token across EVERY read wallet (2026-09-19): a user's holdings
    // legitimately split between their SCW (app-signed trades) and their
    // browser EOA (launchpad/curve buys). Reading one wallet alone reports 0
    // whenever the tokens sit in the other.
    Promise.all(wallets.map((w) => getErc20Balance(contractAddress, w, chainKey))),
    // Dollar-quote pools price directly in USD from slot0 (V3 pools use a raw
    // eth_call — same ABI quirk as findBestV3DollarPool); ETH pools yield
    // token-per-ETH and convert via Chainlink.
    curvePriceUsd != null
      ? Promise.resolve(curvePriceUsd)   // curve coin — priced above from the curve
      : (v4Pool
          ? (isDollarQuote
              ? getV4SpotPriceUsd(v4Pool, contractAddress, decimals, chainKey)
              : getV4SpotPriceEth(v4Pool, decimals, chainKey))
          : (isDollarQuote
              ? getV3DollarSpotPriceUsd({ poolAddress: v3Pool.address, tokenIs0: v3Pool.token0.toLowerCase() === contractAddress.toLowerCase(), tokenDecimals: decimals, chainKey })
              : getTokenSpotPriceEth({ poolAddress: v3Pool.address, wethIsToken0: v3Pool.token0.toLowerCase() === dep.weth.toLowerCase(), tokenDecimals: decimals }, undefined, chainKey))),
    getEthUsdPrice(chainKey),
  ]);
  const summed = balancesRaw.reduce((a, b) => a + b, 0n);
  const balance = Number(formatUnits(summed, decimals));
  let priceUsd;
  if (curvePriceUsd != null) {
    priceUsd = curvePriceUsd;
  } else if (v4Pool && isStockQuote) {
    // LONG token: price via stock-token exit leg (slot0 → V3 WETH → ETH/USD)
    priceUsd = await longTokenPriceUsd(v4Pool, contractAddress, decimals, chainKey).catch(() => 0);
  } else {
    priceUsd = isDollarQuote ? poolPrice : poolPrice * ethUsd;
  }
  const balanceUsd = balance * priceUsd;

  // Cost-basis transfer scan across EVERY read wallet (2026-09-19) — same
  // rationale as the balance sum: acquisitions/exits via the launchpad hit
  // the EOA; app-signed trades hit the SCW. Merge both wallets' histories.
  const transferLists = await Promise.all(
    wallets.flatMap((w) => [
      fetchTransfers({ contractAddress, walletAddress: w, direction: "in", chainKey }),
      fetchTransfers({ contractAddress, walletAddress: w, direction: "out", chainKey }),
    ])
  );
  const seenTxs = new Set();
  const incoming = [];
  const outgoing = [];
  for (const list of transferLists) {
    for (const t of list) {
      // dedupe overlapping transfers (a tx between a user's own two wallets
      // appears in both histories — keep one entry per transfer event)
      const key = (t.hash + ":" + (t.uniqueId ?? (t.blockNum + ":" + t.rawContract?.address)));
      if (seenTxs.has(key)) continue;
      seenTxs.add(key);
      if (t.to && wallets.some((w) => w.toLowerCase() === String(t.to).toLowerCase())) incoming.push(t);
      else outgoing.push(t);
    }
  }
  const truncated = incoming.length >= MAX_TRANSFERS || outgoing.length >= MAX_TRANSFERS;
  const wethLower = dep.weth.toLowerCase();

  // Group by transaction hash: how much TOKEN/dollar/WETH moved in vs out of
  // the wallet within the *same* transaction (i.e. what was actually paid/received).
  const byTx = new Map();
  function bump(hash, block, field, amount) {
    let e = byTx.get(hash);
    if (!e) { e = { block, tokenIn: 0, tokenOut: 0, usdcIn: 0, usdcOut: 0, wethIn: 0, wethOut: 0 }; byTx.set(hash, e); }
    e[field] += amount;
  }
  for (const t of incoming) {
    const block = parseInt(t.blockNum, 16);
    const addr = t.rawContract?.address?.toLowerCase();
    if (addr === tokenLower) bump(t.hash, block, "tokenIn", rawAmount(t, decimals));
    else if (addr === dollarLower) bump(t.hash, block, "usdcIn", rawAmount(t, dep.dollarDecimals));
    else if (addr === wethLower) bump(t.hash, block, "wethIn", rawAmount(t, 18));
  }
  for (const t of outgoing) {
    const block = parseInt(t.blockNum, 16);
    const addr = t.rawContract?.address?.toLowerCase();
    if (addr === tokenLower) bump(t.hash, block, "tokenOut", rawAmount(t, decimals));
    else if (addr === dollarLower) bump(t.hash, block, "usdcOut", rawAmount(t, dep.dollarDecimals));
    else if (addr === wethLower) bump(t.hash, block, "wethOut", rawAmount(t, 18));
  }

  const txs = [...byTx.entries()].map(([hash, e]) => ({ hash, ...e })).sort((a, b) => a.block - b.block);

  if (!txs.length) {
    return {
      balance, balanceUsd, priceUsd, costBasisUsd: null, totalCostBasisUsd: null,
      unrealizedPlUsd: null, unrealizedPlPct: null, realizedPlUsd: 0, transferCount: 0, truncated: false,
    };
  }

  // WETH-denominated cost needs the same historical ETH/USD conversion as
  // native ETH, but no extra RPC call — the amount is already in the transfer.
  const wethPriceBlocks = [...new Set(txs.filter((tx) => tx.tokenIn > 0 && tx.usdcOut === 0 && tx.wethOut > 0).map((tx) => tx.block))];
  const ethUsdCache = new Map();
  await mapLimit(wethPriceBlocks, CONCURRENCY, async (block) => {
    try { ethUsdCache.set(block, await retry(() => getEthUsdPriceAtBlock(block, chainKey))); }
    catch { ethUsdCache.set(block, null); }
  });

  // Only fall back to checking the transaction's native ETH value (an extra
  // RPC call) when neither USDC nor WETH accounts for the acquisition — i.e.
  // it was likely a direct payable ETH→token swap (how buyDip() itself pays).
  const needsEthCheck = txs.filter((tx) => tx.tokenIn > 0 && tx.usdcOut === 0 && tx.wethOut === 0);
  const ethValues = new Map(); // hash -> native ETH sent in that tx
  await mapLimit(needsEthCheck, CONCURRENCY, async (tx) => {
    try { ethValues.set(tx.hash, await getTxEthValue(tx.hash, chainKey)); }
    catch { ethValues.set(tx.hash, 0); }
  });
  const nativeEthPriceBlocks = [...new Set(needsEthCheck.filter((tx) => (ethValues.get(tx.hash) ?? 0) > 0).map((tx) => tx.block))];
  await mapLimit(nativeEthPriceBlocks.filter((b) => !ethUsdCache.has(b)), CONCURRENCY, async (block) => {
    try { ethUsdCache.set(block, await retry(() => getEthUsdPriceAtBlock(block, chainKey))); }
    catch { ethUsdCache.set(block, null); }
  });

  let qty = 0;
  let cost = 0;
  let realizedPl = 0;
  // Blocks where a disposal was paid in WETH or native ETH need the historical
  // ETH/USD price to value the proceeds (USDC proceeds need no conversion).
  const exitBlocks = [...new Set(txs.filter((tx) => tx.tokenOut > 0 && (tx.usdcIn > 0 || tx.wethIn > 0)).map((tx) => tx.block))];
  await mapLimit(exitBlocks.filter((b) => !ethUsdCache.has(b)), CONCURRENCY, async (block) => {
    try { ethUsdCache.set(block, await retry(() => getEthUsdPriceAtBlock(block, chainKey))); }
    catch { ethUsdCache.set(block, null); }
  });
  const needsExitEthCheck = txs.filter((tx) => tx.tokenOut > 0 && tx.usdcIn === 0 && tx.wethIn === 0);
  const exitEthValues = new Map(); // hash -> native ETH received in that tx
  await mapLimit(needsExitEthCheck, CONCURRENCY, async (tx) => {
    try {
      // DELIVERED eth (balance delta), not msg.value: V4 sells deliver via
      // TAKE with msg.value=0, so the old read saw every V4 exit as $0
      // proceeds and excluded it from realized P/L entirely.
      exitEthValues.set(tx.hash, await getTxDeliveredEth(tx.hash, walletAddress, chainKey));
    }
    catch { exitEthValues.set(tx.hash, 0); }
  });
  const exitEthBlocks = [...new Set(needsExitEthCheck.filter((tx) => (exitEthValues.get(tx.hash) ?? 0) > 0).map((tx) => tx.block))];
  await mapLimit(exitEthBlocks.filter((b) => !ethUsdCache.has(b)), CONCURRENCY, async (block) => {
    try { ethUsdCache.set(block, await retry(() => getEthUsdPriceAtBlock(block, chainKey))); }
    catch { ethUsdCache.set(block, null); }
  });

  for (const tx of txs) {
    if (tx.tokenIn > 0) {
      let txCost = tx.usdcOut;
      const ethSpent = tx.wethOut > 0 ? tx.wethOut : (ethValues.get(tx.hash) ?? 0);
      if (ethSpent > 0) {
        const ethUsdAtBlock = ethUsdCache.get(tx.block);
        if (ethUsdAtBlock != null) txCost += ethSpent * ethUsdAtBlock;
      }
      if (txCost > 0) { qty += tx.tokenIn; cost += txCost; }
      // else: no USDC/ETH counter-transfer found in this tx — cost unknown
      // (airdrop, wallet-to-wallet transfer, or paid with some other asset).
      // Conservatively excluded from the running average rather than guessed.
    }
    if (tx.tokenOut > 0 && qty > 0) {
      const avg = cost / qty;
      const removed = Math.min(tx.tokenOut, qty);
      const costRemoved = avg * removed;
      cost -= costRemoved;
      qty -= removed;
      // Realized P/L: actual proceeds received in this tx (USDC/WETH sent to
      // the wallet, or the tx's native ETH value) minus the avg cost removed.
      let proceeds = tx.usdcIn;
      const ethReceived = tx.wethIn > 0 ? tx.wethIn : (exitEthValues.get(tx.hash) ?? 0);
      if (ethReceived > 0) {
        const ethUsdAtBlock = ethUsdCache.get(tx.block);
        if (ethUsdAtBlock != null) proceeds += ethReceived * ethUsdAtBlock;
      }
      if (proceeds > 0) realizedPl += proceeds - costRemoved;
      // else: no USDC/ETH counter-transfer found in this tx — proceeds unknown
      // (sent to another wallet, paid with some other asset). Excluded rather
      // than guessed; the disposal still reduces the avg-cost pool above.
    }
  }

  const costBasisUsd = qty > 0 ? cost / qty : null;
  // Apply the reconstructed average cost to the live on-chain balance (source of
  // truth for holdings) rather than the reconstructed qty, so gaps in history
  // (unpriced acquisitions, free-tier limits) don't corrupt the total.
  const totalCostBasisUsd = costBasisUsd != null ? costBasisUsd * balance : null;
  const unrealizedPlUsd = totalCostBasisUsd != null ? balanceUsd - totalCostBasisUsd : null;
  const unrealizedPlPct = totalCostBasisUsd > 0 ? (unrealizedPlUsd / totalCostBasisUsd) * 100 : null;

  return {
    balance, balanceUsd, priceUsd, costBasisUsd, totalCostBasisUsd,
    unrealizedPlUsd, unrealizedPlPct, realizedPlUsd: realizedPl, transferCount: incoming.length + outgoing.length, truncated,
  };
}
