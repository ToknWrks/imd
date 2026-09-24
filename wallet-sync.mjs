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
import { insertSniperTrade, getSniperTxHashes } from "./db.mjs";
import { createPublicClient, http, decodeEventLog, parseAbi, getAddress, formatUnits } from "viem";

const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const ALCHEMY_SUBDOMAIN = { ethereum: "eth-mainnet", base: "base-mainnet", robinhood: "robinhood-mainnet" };
const MAX_TRANSFERS = 2000;

/** ETH proceeds of a SELL from the V4 PoolManager Swap event.
 *  v4 Swap amounts are from the SWAPPER's perspective (verified on-chain
 *  2026-09-24, tx 0x2932b99e: a 1-IMD sell logged amount1(IMD) = -1e18 and
 *  amount0(ETH) = +1.98e15). So on a sell the TOKEN side is NEGATIVE (paid by
 *  the swapper) and the QUOTE side is POSITIVE (received). The old decoder
 *  assumed pool perspective and returned the token quantity as "ETH" —
 *  recording 1 ETH of proceeds for a 1-IMD sell. Only ETH-quoted pools
 *  (currency0 = native ETH) return a value; anything else returns null.
 *  tokenAmountRaw (bigint, optional) disambiguates when several Swap events
 *  are in the receipt. */
async function v4SwapProceedsEth(txHash, chainKey, tokenAmountRaw) {
  const dep = getChain(chainKey);
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (!key) return null;
  const sub = { ethereum: "eth-mainnet", base: "base-mainnet", robinhood: "robinhood-mainnet" }[chainKey] ?? "eth-mainnet";
  const c = createPublicClient({ transport: http(`https://${sub}.g.alchemy.com/v2/${key}`) });
  const r = await c.getTransactionReceipt({ hash: txHash });
  const raw = typeof tokenAmountRaw === "bigint" ? tokenAmountRaw : null;
  let fallback = null;
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== String(dep.v4?.poolManager ?? "").toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({
        abi: parseAbi(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"]),
        data: log.data, topics: log.topics,
      });
    } catch { continue; }
    const a0 = BigInt(ev.args.amount0), a1 = BigInt(ev.args.amount1);
    // ETH pools: currency0 = native ETH. Sell ⇒ a1 (token) < 0, a0 (ETH) > 0.
    if (!(a1 < 0n && a0 > 0n)) continue;
    if (raw != null && -a1 === raw) return Number(a0) / 1e18; // exact match
    if (fallback == null) fallback = Number(a0) / 1e18;
  }
  return raw == null ? fallback : null;
}

function alchemyUrl(chainKey) {
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (!key) throw new Error("ALCHEMY_API_KEY required for wallet sync");
  return `https://${ALCHEMY_SUBDOMAIN[chainKey] ?? "eth-mainnet"}.g.alchemy.com/v2/${key}`;
}

/** All erc20 transfers in/out of the wallet among {token, dollar, weth}.
 *  (Native ETH legs are fetched separately by fetchNativeEth — smart-wallet
 *  trades move ETH as INTERNAL transfers, which never appear as msg.value
 *  of the bundle tx or as ERC-20 transfers.) */
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

/** Native ETH (external + internal) sent FROM / received BY the wallet, keyed
 *  by tx hash. Smart-wallet trades pay/receive ETH via internal calls inside
 *  the EntryPoint bundle, so this is the only place their cost/proceeds show. */
async function fetchNativeEth({ chainKey, wallet }) {
  const url = alchemyUrl(chainKey);
  const sums = new Map(); // hash -> { out, in }
  for (const dir of ["fromAddress", "toAddress"]) {
    let pageKey, n = 0;
    do {
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{
          fromBlock: "0x0", toBlock: "latest", category: ["external", "internal"], order: "asc", maxCount: "0x3e8",
          [dir]: wallet, ...(pageKey ? { pageKey } : {}),
        }] }),
      });
      const body = await res.json();
      if (body.error) throw new Error(`alchemy_getAssetTransfers (native): ${body.error.message}`);
      for (const t of body.result.transfers) {
        const v = Number(t.value ?? 0);
        if (!(v > 0)) continue;
        const e = sums.get(t.hash) ?? { out: 0, in: 0 };
        if (dir === "fromAddress") e.out += v; else e.in += v;
        sums.set(t.hash, e);
        n++;
      }
      pageKey = body.result.pageKey;
    } while (pageKey && n < MAX_TRANSFERS);
  }
  return sums;
}

/**
 * Reconcile external trades for one token into sniper_trades.
 * Returns { added, skipped } — added rows carry dex="EXT (wallet sync)".
 */
export async function syncExternalTrades({ chainKey, tokenAddress, wallet, userId = null, ownWallets = null }) {
  const dep = getChain(chainKey);
  const token = String(tokenAddress).toLowerCase();
  const ethUsd = await getEthUsdPrice(chainKey).catch(() => null);
  // Chain client for the net-balance classification (see below) — batch off,
  // retryCount 1 so a flaky RPC degrades to the transfer-direction fallback.
  const c = createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc(), { batch: false, retryCount: 1 }) });

  const [inT, outT, nativeEth] = await Promise.all([
    fetchTransfers({ chainKey, token, wallet, direction: "in" }),
    fetchTransfers({ chainKey, token, wallet, direction: "out" }),
    fetchNativeEth({ chainKey, wallet }).catch(() => new Map()),
  ]);
  const byTx = new Map();
  for (const t of [...inT, ...outT]) {
    if (!byTx.has(t.hash)) byTx.set(t.hash, []);
    byTx.get(t.hash).push(t);
  }

  // Dedupe on EVERY recorded hash, any status (see getSniperTxHashes).
  const known = getSniperTxHashes(chainKey, token);
  // The user's own wallets (SCW + login EOA). A tx that only moves the token
  // between them is a TRANSFER, not a trade — recording it made withdrawals
  // look like sells for ~0 ETH and deposits like unpriced buys (IMD ledger,
  // 2026-09-24: rows 79/80/96 were SCW→EOA withdrawals booked as sells).
  const own = new Set([wallet, ...(ownWallets ?? [])].filter(Boolean).map((a) => String(a).toLowerCase()));
  let added = 0, skipped = 0;

  for (const [tx, transfers] of byTx) {
    if (known.has(tx.toLowerCase())) { skipped++; continue; }
    // Self-transfer between the user's own wallets → not a trade.
    {
      const tokTransfers = transfers.filter((t) => String(t.rawContract?.address ?? "").toLowerCase() === token);
      if (own.size > 1 && tokTransfers.length && tokTransfers.every((t) => own.has(String(t.from).toLowerCase()) && own.has(String(t.to).toLowerCase()))) {
        skipped++; continue;
      }
    }
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
      const nativeIn = nativeEth.get(tx)?.in ?? 0;
      if (dollarAmt > 0 && ethUsd > 0) ethReceived = dollarAmt / ethUsd;
      else if (wethAmt > 0) ethReceived = wethAmt;
      else if (nativeIn > 0) ethReceived = nativeIn; // SCW / native TAKE proceeds (internal transfer)
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
      const nativeOut = nativeEth.get(tx)?.out ?? 0;
      if (wethAmt > 0) ethSpent = wethAmt;
      else if (dollarAmt > 0 && ethUsd > 0) ethSpent = dollarAmt / ethUsd;
      else if (nativeOut > 0) ethSpent = nativeOut; // SCW buys: ETH leaves as internal transfers
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
      user_id: userId,
    });
    added++;
  }
  return { added, skipped };
}
