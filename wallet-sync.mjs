/**
 * wallet-sync.mjs — reconcile external trades (Uniswap UI, etc.) into the
 * sniper ledger. The ledger drives P/L, autosell baselines, and the sniper →
 * accumulation migration cost basis, so trades made outside the app through
 * any DEX must flow back in here.
 *
 * Approach (mirrors wallet-position.mjs's transfer reconstruction):
 *   1. alchemy_getAssetTransfers: every {token, dollar, WETH} erc20 transfer
 *      in AND out of the wallet for one token contract.
 *   2. Group by tx hash. A tx with TOKEN out + (ETH value | WETH/dollar in)
 *      = a SELL through some DEX; TOKEN in + ETH value out = a BUY.
 *   3. Proceeds/cost in ETH terms (dollar converted at the live ETH/USD rate —
 *      approximation for historical rows, flagged via dex label).
 *   4. Dedupe: only insert tx hashes not already in sniper_trades
 *      (buy_tx_hash stores both buys' and sells' tx hashes).
 */
import { getChain } from "./chains.mjs";
import { getEthUsdPrice } from "./dip-swap.mjs";
import { insertSniperTrade, getSniperTokenHistory, getSniperTokenHistoryUnpriced } from "./db.mjs";
import { createPublicClient, http, decodeEventLog, parseAbi, getAddress, formatUnits } from "viem";

const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const ALCHEMY_SUBDOMAIN = { ethereum: "eth-mainnet", base: "base-mainnet", robinhood: "robinhood-mainnet" };
const MAX_TRANSFERS = 2000;

/** Decode a V4 Swap event: proceeds = the pool's negative delta (quote side).
 *  Pool-perspective deltas: for a sell, the pool RECEIVES the sold token
 *  (positive delta) and PAYS the quote (negative delta) → proceeds = |neg|.
 *  The caller passes tokenAmountRaw so the token side can be identified by
 *  magnitude match (handles both currency orders); if neither side matches,
 *  falls back to the negative side (sell direction is unambiguous). */
async function v4SwapProceedsEth(txHash, chainKey, tokenAmountRaw) {
  const dep = getChain(chainKey);
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (!key) return null;
  const sub = { ethereum: "eth-mainnet", base: "base-mainnet", robinhood: "robinhood-mainnet" }[chainKey] ?? "eth-mainnet";
  const c = createPublicClient({ transport: http(`https://${sub}.g.alchemy.com/v2/${key}`) });
  const r = await c.getTransactionReceipt({ hash: txHash });
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== String(dep.v4?.poolManager ?? "").toLowerCase()) continue;
    try {
      const ev = decodeEventLog({
        abi: parseAbi(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 protocolFee)"]),
        data: log.data, topics: log.topics,
      });
      const a0 = ev.args.amount0, a1 = ev.args.amount1;
      // Identify the token side by matching the actual transferred amount.
      if (tokenAmountRaw != null) {
        if (a0 > 0n && BigInt(a0) === tokenAmountRaw) return Number(-a1) / 1e18; // token=c0 → proceeds=c1
        if (a1 > 0n && BigInt(a1) === tokenAmountRaw) return Number(-a0) / 1e18; // token=c1 → proceeds=c0
      }
      // The negative side is what the pool PAID — on a SELL that must be the
      // QUOTE (currency0/1 that is NOT our token). If the negative side is the
      // token itself, the "sell" was actually a BUY routed through flash
      // accounting (pool pays the token to the wallet while receiving the
      // quote) — returning the token quantity as "ETH proceeds" recorded
      // 139.0 ETH for a 0.02 ETH sell (HASH, 2026-09-13).
      const neg = a0 < 0n ? a0 : a1 < 0n ? a1 : null;
      if (neg == null) return null;
      const tokenSideIsNeg = tokenAmountRaw != null && (BigInt(a0) === tokenAmountRaw || BigInt(a1) === tokenAmountRaw)
        ? (a0 < 0n && BigInt(-a0) === tokenAmountRaw) || (a1 < 0n && BigInt(-a1) === tokenAmountRaw)
        : null;
      if (tokenSideIsNeg) return null; // negative side IS the token — this is a buy, proceeds unknown here
      return Number(-neg) / 1e18;
    } catch { continue; }
  }
  return null;
}

function alchemyUrl(chainKey) {
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (!key) throw new Error("ALCHEMY_API_KEY required for wallet sync");
  return `https://${ALCHEMY_SUBDOMAIN[chainKey] ?? "eth-mainnet"}.g.alchemy.com/v2/${key}`;
}

/** All erc20 transfers in/out of the wallet among {token, dollar, weth}. */
async function fetchTransfers({ chainKey, token, wallet, direction }) {
  const dep = getChain(chainKey);
  const url = alchemyUrl(chainKey);
  const addressKey = direction === "in" ? "toAddress" : "fromAddress";
  let out = [], pageKey;
  do {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{
        fromBlock: "0x0", toBlock: "latest", category: ["erc20"], withMetadata: true, order: "asc", maxCount: "0x3e8",
        contractAddresses: [token, dep.dollar, dep.weth].filter(Boolean),
        [addressKey]: wallet, ...(pageKey ? { pageKey } : {}),
      }] }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`alchemy_getAssetTransfers: ${body.error.message}`);
    out = out.concat(body.result.transfers.map((t) => ({ ...t, dir: direction })));
    pageKey = body.result.pageKey;
  } while (pageKey && out.length < MAX_TRANSFERS);
  return out.slice(0, MAX_TRANSFERS);
}

/**
 * Reconcile external trades for one token into sniper_trades.
 * Returns { added, skipped } — added rows carry dex="EXT (wallet sync)".
 */
export async function syncExternalTrades({ chainKey, tokenAddress, wallet }) {
  const dep = getChain(chainKey);
  const token = String(tokenAddress).toLowerCase();
  const ethUsd = await getEthUsdPrice(chainKey).catch(() => null);
  // Chain client for the net-balance classification (see below) — batch off,
  // retryCount 1 so a flaky RPC degrades to the transfer-direction fallback.
  const c = createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc(), { batch: false, retryCount: 1 }) });

  const [inT, outT] = await Promise.all([
    fetchTransfers({ chainKey, token, wallet, direction: "in" }),
    fetchTransfers({ chainKey, token, wallet, direction: "out" }),
  ]);
  const byTx = new Map();
  for (const t of [...inT, ...outT]) {
    if (!byTx.has(t.hash)) byTx.set(t.hash, []);
    byTx.get(t.hash).push(t);
  }

  const known = new Set(getSniperTokenHistory(chainKey, token).map((t) => String(t.buy_tx_hash || "").toLowerCase()));
  // Rows with NO price info (eth_spent AND eth_received NULL) are excluded
  // from getSniperTokenHistory's priced-only filter — track them separately
  // or a re-sync re-inserts them as priced duplicates (HASH buy 0xeedd4c58
  // existed as an unpriced row from the old sync bug; re-sync added it again
  // with cost, double-counting the position).
  const knownUnpriced = new Set(getSniperTokenHistoryUnpriced(chainKey, token).map((t) => String(t.buy_tx_hash || "").toLowerCase()));
  let added = 0, skipped = 0;

  for (const [tx, transfers] of byTx) {
    if (known.has(tx.toLowerCase()) || knownUnpriced.has(tx.toLowerCase())) { skipped++; continue; }
    const tokenLc = token.toLowerCase();
    const tokenOut = transfers.filter((t) => t.dir === "out" && String(t.rawContract?.address ?? "").toLowerCase() === tokenLc);
    const tokenIn = transfers.filter((t) => t.dir === "in" && String(t.rawContract?.address ?? "").toLowerCase() === tokenLc);
    // Transfer DIRECTION alone lies on V4: flash accounting routes the pool's
    // payment THROUGH the wallet, so a BUY shows token out (the pool's token
    // payment passing onward) and a SELL can show token in. The ground truth
    // is the wallet's NET token delta across the tx — read it from the
    // balance at (block-1) vs (block). (HASH: a 0.02-ETH sell was recorded
    // with 139.0 ETH "proceeds" because the transfer filter saw token-out.)
    let netTokenDelta = null;
    try {
      const firstOut = tokenOut[0] ?? tokenIn[0];
      const raw = firstOut?.rawContract?.value != null ? BigInt(firstOut.rawContract.value) : null;
      if (raw != null) {
        const rec = await c.getTransactionReceipt({ hash: tx });
        // BOTH reads must be at the tx's block. The original code read the
        // "now" balance at `latest`, so once the position was fully exited
        // every HISTORICAL buy classified as net-zero and was skipped (IF,
        // 2026-09-14: 8 external buys — 4 USDG, 4 native ETH — vanished from
        // the ledger because balNow@latest ≈ balBefore after the exit sell).
        const blk = rec.blockNumber;
        const balNow = await c.readContract({ address: getAddress(token), abi: ERC20_ABI, functionName: "balanceOf", args: [wallet], blockNumber: blk });
        const balBefore = await c.readContract({ address: getAddress(token), abi: ERC20_ABI, functionName: "balanceOf", args: [wallet], blockNumber: blk - 1n });
        netTokenDelta = balNow - balBefore; // negative = sold, positive = bought
      }
    } catch { /* fall back to transfer direction below */ }
    const isSell = netTokenDelta != null
      ? netTokenDelta < 0n
      : (tokenOut.length > 0 && tokenIn.length === 0);
    const isBuy = netTokenDelta != null
      ? netTokenDelta > 0n
      : (tokenIn.length > 0 && tokenOut.length === 0);
    if (!isSell && !isBuy) { skipped++; continue; } // net-zero (self-transfer/route-through) or unknown shape

    // Proceeds (sell): dollar/WETH received in the same tx, in ETH terms.
    // Fall back to decoding the V4 Swap event from the receipt — Uniswap's UI
    // often settles via native ETH (TAKE + unwrap), which never appears as an
    // ERC-20 transfer. amount0/1 are pool-perspective deltas: for a sell the
    // pool's quote-currency balance DECREASES (negative delta = proceeds).
    const dec = Number(dep.dollarDecimals ?? 6);
    const dollarIn = dep.dollar
      ? transfers.filter((t) => t.dir === "in" && String(t.rawContract?.address ?? "").toLowerCase() === String(dep.dollar).toLowerCase())
      : [];
    const wethIn = transfers.filter((t) => t.dir === "in" && String(t.rawContract?.address ?? "").toLowerCase() === String(dep.weth).toLowerCase());
    let ethReceived = null;
    if (isSell) {
      const dollarAmt = dollarIn.reduce((s, t) => s + Number(t.value ?? 0), 0);
      const wethAmt = wethIn.reduce((s, t) => s + Number(t.value ?? 0), 0);
      if (dollarAmt > 0 && ethUsd > 0) ethReceived = dollarAmt / ethUsd;
      else if (wethAmt > 0) ethReceived = wethAmt;
      if (ethReceived == null) ethReceived = await v4SwapProceedsEth(tx, chainKey, tokenLc).catch(() => null);
      // Some V4 pools settle through a WETH-side route that unwraps to native
      // ETH (TAKE → internal transfer): no PoolManager Swap event decodable
      // under the canonical PoolManager and no ERC-20 transfer. Measure the
      // wallet's native ETH delta instead (HASH exit lesson, getTxDeliveredEth).
      if (ethReceived == null && dep.httpRpc) {
        try {
          const { getTxDeliveredEth } = await import("./dip-swap.mjs");
          const delivered = await getTxDeliveredEth(tx, wallet, chainKey);
          if (delivered > 0) ethReceived = delivered;
        } catch { /* leave null — P/L flags the row honestly via realizedUnknown */ }
      }
      // else: proceeds were some other token — record the sell with null
      // proceeds (P/L treats unknown-sell honestly via realizedUnknown).
    }
    // Cost (buy): WETH out of the wallet in the same tx, else null (native
    // ETH value isn't in the transfers API — a WETH-less ETH buy stays unknown
    // and P/L marks it honestly).
    let ethSpent = null;
    if (isBuy) {
      const wethOut = transfers.filter((t) => t.dir === "out" && String(t.rawContract?.address ?? "").toLowerCase() === String(dep.weth).toLowerCase());
      const dollarOut = dep.dollar
        ? transfers.filter((t) => t.dir === "out" && String(t.rawContract?.address ?? "").toLowerCase() === String(dep.dollar).toLowerCase())
        : [];
      const wethAmt = wethOut.reduce((s, t) => s + Number(t.value ?? 0), 0);
      const dollarAmt = dollarOut.reduce((s, t) => s + Number(t.value ?? 0), 0);
      if (wethAmt > 0) ethSpent = wethAmt;
      else if (dollarAmt > 0 && ethUsd > 0) ethSpent = dollarAmt / ethUsd;
      // Native-ETH buy: the wallet attached ETH to the tx (msg.value) — the
      // transfers API never shows it, but for an external router swap
      // msg.value IS the cost (IF native buys, 2026-09-14: 0.002 ETH each,
      // previously recorded with null cost which OVERSTATED realized P/L).
      if (ethSpent == null) {
        try {
          const txObj = await c.getTransaction({ hash: tx });
          const val = Number(txObj?.value ?? 0n) / 1e18;
          if (val > 0) ethSpent = val;
        } catch { /* leave null — P/L flags the row honestly */ }
      }
    }

    const tokenAmount = isSell
      ? tokenOut.reduce((s, t) => s + Number(t.value ?? 0), 0)
      : tokenIn.reduce((s, t) => s + Number(t.value ?? 0), 0);
    if (!(tokenAmount > 0)) { skipped++; continue; }
    // Retry proceeds with the exact token amount (18-decimals raw) for the
    // Swap-event side-matching (value from the transfers API may be rounded).
    if (isSell && ethReceived == null) {
      const raw = transfers.find((t) => t.dir === "out" && String(t.rawContract?.address ?? "").toLowerCase() === tokenLc)?.rawContract?.value;
      if (raw != null) ethReceived = await v4SwapProceedsEth(tx, chainKey, BigInt(raw)).catch(() => null);
    }

    insertSniperTrade({
      chain: chainKey, contract_address: tokenLc,
      // Label the row with the TOKEN's asset name — the first transfer's asset
      // may be the quote leg (USDG), which mislabeled an IF sell as "USDG".
      symbol: [...tokenIn, ...tokenOut].find((t) => t.asset)?.asset ?? null,
      dex: (isSell ? "SELL EXT " : "") + "wallet sync",
      eth_spent: isSell ? 0 : ethSpent,
      token_amount: tokenAmount,
      buy_tx_hash: tx,
      eth_received: isSell ? ethReceived : null,
    });
    added++;
  }
  return { added, skipped };
}
