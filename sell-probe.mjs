/**
 * sell-probe.mjs — honeypot guard: verify a token actually PAYS sellers.
 *
 * A honeypot looks perfect until you sell: the buy works, the price pumps,
 * the sell tx "succeeds" — and nothing arrives in the wallet (QUORUM did
 * exactly this, 2026-09-11: 57.6k tokens sold, $0 delivered). The existing
 * quote-level guard (quoteSellProceedsEth vs probe fair value) cannot catch
 * these because hooked/malicious contracts can return a healthy QUOTE and
 * then swallow the transfer.
 *
 * The only trustworthy check is EMPIRICAL: a tiny real sell, then read the
 * wallet's balance delta for the QUOTE ASSET after the receipt confirms.
 *
 * Quoted-asset determination (learned 2026-09-12 — the first version measured
 * native ETH and misclassified a USDG-quoted honeypot as "delivered" because
 * the native delta caught a gas-refund wiggle, not proceeds):
 *   - the sell's own quote asset is resolved from the venue (pool.currency0/1
 *     for V4, token0/1 for V3) — the asset the pool PAYS OUT is what must
 *     grow in the wallet;
 *   - native ETH is only the expected asset when the quote IS native ETH;
 *   - USDG/USDC-quoted pools must show a dollar-token balance increase.
 * The on-chain ground truth for the QUORUM probe: the receipt contained zero
 * USDG transfers — the pool "swapped" and delivered nothing.
 *
 * Everything here is best-effort: a probe that cannot complete (RPC hiccup)
 * returns { verdict: "error" } and never blocks a legitimate trade on its own.
 */
import { createPublicClient, http, parseAbi } from "viem";
import { getChain } from "./chains.mjs";
import { executeSniperSell, resolveSellVenueForProbe } from "./sniper-extras.mjs";
import { recordGasForTx } from "./gas-ledger.mjs";
import { resolvePoolOverride } from "./dip-swap.mjs";
import { findLongVenue, isLongVenue } from "./long-platform.mjs";

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * Balance of `asset` (native ETH zero-address or ERC-20) for `wallet`.
 * Returns a bigint of raw units, or null when the read fails.
 */
async function rawBalance(httpClient, asset, wallet) {
  try {
    if (asset.toLowerCase() === NATIVE) {
      return await httpClient.getBalance({ address: wallet });
    }
    return await httpClient.readContract({
      address: asset, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet],
    });
  } catch {
    return null;
  }
}

/**
 * Sell a tiny amount of `token` and verify the wallet's quote-asset balance
 * actually rises by a material amount.
 *
 * @returns {Promise<{verdict: "delivered"|"stiffed"|"error", sellTxHash?: string,
 *   quoteAsset?: string, balanceBeforeRaw?: bigint, balanceAfterRaw?: bigint,
 *   deltaRaw?: bigint, reason?: string}>}
 */
export async function probeSellDeliverability({ signer, chainKey, tokenAddress, amountHuman, pool = null, slippagePct = 3 }) {
  const dep = getChain(chainKey);
  const client = createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc(), { batch: false, retryCount: 1 }) });
  const wallet = signer.address;

  // Resolve the venue the sell will use so we know the QUOTE asset to verify.
  // executeSniperSell resolves internally; duplicate that resolution read-only
  // (the pool override string flows straight through).
  let quoteAsset = NATIVE; // default: native ETH (most pools)
  let preChosen = null;
  try {
    const token = tokenAddress;
    if (chainKey === "robinhood" && !(pool?.dex)) {
      let longVenue = await findLongVenue(token, chainKey).catch(() => null);
      if (!longVenue && typeof pool === "string" && pool.trim() && pool.toLowerCase() !== "auto") {
        const resolved = await resolvePoolOverride(token, pool, chainKey).catch(() => null);
        if (resolved && isLongVenue(resolved)) longVenue = resolved;
      }
      if (longVenue) quoteAsset = NATIVE; // LONG path ends in native ETH
      else {
        preChosen = await resolveSellVenueForProbe(token, chainKey, typeof pool === "string" ? pool : null);
        quoteAsset = quoteAssetOfVenue(preChosen, token, dep);
      }
    } else if (pool?.dex) {
      preChosen = pool;
      quoteAsset = quoteAssetOfVenue(pool, tokenAddress, dep);
    } else {
      preChosen = await resolveSellVenueForProbe(tokenAddress, chainKey, null);
      quoteAsset = quoteAssetOfVenue(preChosen, tokenAddress, dep);
    }
  } catch {
    quoteAsset = NATIVE; // resolution failed — fall back to native (imperfect)
  }

  let beforeQuote = await rawBalance(client, quoteAsset, wallet);

  let result;
  try {
    result = await executeSniperSell({ signer, chainKey, tokenAddress, amountHuman, slippagePct, pool });
  } catch (e) {
    return { verdict: "error", reason: `probe sell failed: ${e.message}` };
  }

  // WETH-OUT CHAINS (Robinhood 4663: WETH9 withdraw() burns proceeds — verified
  // 2026-09-12): the V3 sell delivers WETH to the wallet instead of native ETH.
  // Measure the ACTUAL WETH delivered from the receipt's Transfer logs (to the
  // wallet, WETH contract) — do not trust result.quotedOut (it's a minimum-out
  // estimate and can be 0 when the linear probe quote fails). before = now
  // balance minus actual delivered; delta = after − before ≥ 0 iff paid.
  if (result.wethOut && dep.weth) {
    quoteAsset = dep.weth;
    const nowWeth = await rawBalance(client, quoteAsset, wallet);
    if (nowWeth == null) {
      return { verdict: "error", sellTxHash: result.txHash, quoteAsset, reason: "could not read WETH balance (RPC failure) — verdict unknown" };
    }
    let deliveredRaw = 0n;
    try {
      const rec = await client.getTransactionReceipt({ hash: result.txHash });
      const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      for (const l of rec.logs) {
        if (l.address.toLowerCase() !== dep.weth.toLowerCase()) continue;
        if (!(l.topics[0] ?? "").startsWith(TRANSFER)) continue;
        const to = "0x" + (l.topics[2] ?? "").slice(26);
        if (to.toLowerCase() === wallet.toLowerCase()) deliveredRaw += BigInt(l.data);
      }
    } catch { /* fall back to quotedOut below */ }
    if (deliveredRaw === 0n && result.quotedOut != null) deliveredRaw = BigInt(result.quotedOut);
    beforeQuote = nowWeth - deliveredRaw;
  }

  // Wait for the receipt so the balance reads are post-swap.
  try { await client.waitForTransactionReceipt({ hash: result.txHash }); } catch { /* best effort */ }
  recordGasForTx(result.txHash, chainKey).catch(() => {}); // gas ledger
  const afterQuote = await rawBalance(client, quoteAsset, wallet);

  const delta = (afterQuote != null && beforeQuote != null)
    ? afterQuote - beforeQuote
    : null;

  // Convert the sell's own quoted proceeds into the quote asset's raw units
  // for a magnitude comparison. result.ethReceived is ETH-denominated.
  const ethUsd = await getEthUsdForProbe(chainKey);
  const quotedQuoteRaw = quotedQuoteRawAmount(result, quoteAsset, dep, ethUsd);

  // Honeypot signature: the sell tx succeeds (executeSniperSell throws on
  // revert) but the quote-asset balance does NOT rise materially. Gas is
  // paid separately (native), so for a dollar-quoted pool even an exactly
  // zero delta means the tokens were donated.
  const minExpectedRaw = quotedQuoteRaw != null && quotedQuoteRaw > 0n
    ? (quotedQuoteRaw * 5n) / 10n // ≥50% of quoted proceeds
    : null;

  if (delta == null) {
    return { verdict: "error", sellTxHash: result.txHash, quoteAsset, reason: "could not read quote-asset balances (RPC failure) — verdict unknown" };
  }
  if (delta <= 0n || (minExpectedRaw != null && delta < minExpectedRaw)) {
    const gotHuman = Number(delta ?? 0n) / 10 ** (quoteAsset === NATIVE ? 18 : dep.dollarDecimals);
    const quotedHuman = quotedQuoteRaw != null ? Number(quotedQuoteRaw) / 10 ** (quoteAsset === NATIVE ? 18 : dep.dollarDecimals) : null;
    return {
      verdict: "stiffed",
      sellTxHash: result.txHash,
      quoteAsset,
      balanceBeforeRaw: beforeQuote,
      balanceAfterRaw: afterQuote,
      deltaRaw: delta,
      reason: `quote-asset delta after sell = ${gotHuman} (quoted ~${quotedHuman ?? "?"}) — the swap succeeded but the wallet received nothing/most of nothing. Token is NOT sellable (honeypot signature).`,
    };
  }

  return { verdict: "delivered", sellTxHash: result.txHash, quoteAsset, balanceBeforeRaw: beforeQuote, balanceAfterRaw: afterQuote, deltaRaw: delta };
}

/** The asset a venue's sell delivers to the wallet. */
function quoteAssetOfVenue(chosen, token, dep, result = null) {
  if (!chosen) return NATIVE;
  if (chosen.dex === "V3_DOLLAR") return dep.dollar;
  if (chosen.dex === "V4" && chosen.currency0 && chosen.currency1) {
    const tokenIs0 = String(chosen.currency0).toLowerCase() === String(token).toLowerCase();
    const quote = tokenIs0 ? chosen.currency1 : chosen.currency0;
    // V4 sells deliver the quote asset; native ETH arrives via TAKE (native),
    // WETH arrives as WETH — treat WETH as native-equivalent (it is unwrapped
    // only on V3 paths; a V4 WETH-quoted pool delivers WETH itself).
    return String(quote).toLowerCase() === NATIVE ? NATIVE : quote;
  }
  if (chosen.dex === "V3" || chosen.dex === "V2" || chosen.dex === "AERODROME") {
    // These paths unwrap WETH and deliver native ETH — EXCEPT on chains whose
    // WETH9 withdraw() is broken (Robinhood 4663: withdraw() burns the WETH,
    // verified 2026-09-12). There the V3 sell delivers WETH to the wallet
    // (executeSniperSell returns wethOut: true) and the probe must measure the
    // WETH delta instead of native ETH.
    if (result?.wethOut && dep.weth) return dep.weth;
    return NATIVE;
  }
  return NATIVE;
}

/** The sell result's quoted proceeds re-denominated into the quote asset raw. */
function quotedQuoteRawAmount(result, quoteAsset, dep, ethUsd) {
  const ethReceived = Number(result.ethReceived ?? 0);
  if (!(ethReceived > 0)) return null;
  if (quoteAsset === NATIVE) return BigInt(Math.round(ethReceived * 1e18));
  if (!(ethUsd > 0)) return null;
  // ethReceived = quoteTokens / ethUsd → quoteTokens = ethReceived × ethUsd
  return BigInt(Math.round(ethReceived * ethUsd * 10 ** (dep.dollarDecimals ?? 6)));
}

async function getEthUsdForProbe(chainKey) {
  try {
    const { getEthUsd } = await import("./sniper-swap.mjs");
    return Number(await getEthUsd(chainKey) ?? 0);
  } catch { return 0; }
}
