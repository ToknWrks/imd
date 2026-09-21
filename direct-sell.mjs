/**
 * direct-sell.mjs — build manual co-pilot trade txs WITHOUT a server signer.
 *
 * 2026-09-21 direct-sign flow: manual buys/sells in co-pilot mode go straight
 * to the user's wallet. Every builder below reuses the SAME server-side
 * execution function autonomy mode uses (sellCurveCoin, executeV4Sell,
 * executeSniperSell, executeSniperBuy, buyToken) via a "capture signer" that
 * hands back whichever call it attempts NEXT instead of sending it — when a
 * Permit2/ERC-20 allowance leg is missing, that's an approve() call, not the
 * trade. `isApproval` tells the caller which one it got, so the route can be
 * hit again after the approve mines instead of recording an approve tx as a
 * completed trade in the ledger. This is what makes co-pilot manual trades
 * match autonomy's approval handling exactly, one user signature per step.
 *
 * Returns { to, data, value, gas?, isApproval } — exactly what directSignTx
 * needs plus the flag the client chains on.
 */
import { getAddress } from "viem";

// The wrapped execution functions can leave a stray promise rejecting after
// the capture-signer's synchronous CAPTURE-STOP unwinds the call (e.g. a
// parallel allowance read losing the race) — guard once, not per-call, to
// avoid a MaxListenersExceededWarning across repeated manual-trade clicks.
let _unhandledRejectionGuarded = false;
function guardUnhandledRejection() {
  if (_unhandledRejectionGuarded) return;
  _unhandledRejectionGuarded = true;
  process.on("unhandledRejection", () => {});
}

async function captureFirstCall(address, chainKey, fn) {
  guardUnhandledRejection();
  let captured = null;
  const captureSigner = {
    address: getAddress(address),
    // Buy-side pre-flight guards (buyToken/buyCurveCoin/buyDip) read this
    // BEFORE the first callContract — a stub here throws "getEthBalanceWei
    // is not a function" and kills every co-pilot buy (found live 2026-09-21).
    async getEthBalanceWei() {
      const { publicClient } = await import("./sniper-swap.mjs");
      return publicClient(chainKey).getBalance({ address: getAddress(address) });
    },
    async callContract(call) { captured = call; throw new Error("CAPTURE-STOP"); },
  };
  try {
    await fn(captureSigner);
  } catch (e) {
    if (!/CAPTURE-STOP/.test(String(e.message))) throw e; // real error (quote/venue/price) — surface it
  }
  if (!captured) throw new Error("could not build the transaction (allowance leg blocked capture — approve first)");
  const { encodeFunctionData } = await import("viem");
  return {
    to: getAddress(captured.address),
    data: encodeFunctionData({ abi: captured.abi, functionName: captured.functionName, args: captured.args }),
    value: (captured.value ?? 0n).toString(),
    isApproval: captured.functionName === "approve",
  };
}

export async function buildDirectCurveSell({ tokenAddress, coinAmountWei, sellerAddress, slippagePct = 3, chainKey = "ethereum", curveState, imdPerEth, universalRouter }) {
  if (!curveState || !imdPerEth || !universalRouter) throw new Error("buildDirectCurveSell needs { curveState, imdPerEth, universalRouter }");
  const { sellCurveCoin } = await import("./curve-buy.mjs");
  const built = await captureFirstCall(sellerAddress, chainKey, (signer) =>
    sellCurveCoin(signer, tokenAddress, coinAmountWei, { slippagePct, chainKey, curveState, imdPerEth, universalRouter }));
  return { ...built, value: "0", gas: 450000 };
}

/**
 * buildDirectV4Sell — wraps executeV4Sell (sniper-extras.mjs), which checks
 * and sets the Permit2 allowance chain (erc20→Permit2, Permit2→router)
 * BEFORE building the swap. Without this, the raw swap call reverts
 * TRANSFER_FROM_FAILED on any wallet that hasn't already max-approved
 * Permit2 for this token (found live 2026-09-21).
 */
export async function buildDirectV4Sell({ chainKey, tokenAddress, amountIn, slippagePct, pool, sellerAddress }) {
  const { executeV4Sell } = await import("./sniper-extras.mjs");
  return captureFirstCall(sellerAddress, chainKey, (signer) =>
    executeV4Sell({ signer, chainKey, tokenAddress, amountIn, slippagePct, pool }));
}

/**
 * buildDirectSniperSell — wraps the top-level executeSniperSell dispatcher,
 * so every venue it knows about (curve, V4, V3_DOLLAR, V3/V2/Aerodrome with
 * plain ERC-20 router approvals) gets the same staged approve→…→sell
 * treatment automatically, with no per-venue duplication here.
 *
 * NOT safe for Robinhood LONG-platform tokens: executeLongSell sends TWO
 * sequential txs (token→stock, then stock→ETH) and the second leg depends
 * on the first already having landed on-chain — capturing leg 1 and then
 * re-invoking this builder from scratch would try to re-sell a balance that
 * no longer exists. Callers must route LONG-platform sells through the
 * existing co-pilot approval-modal path instead (see sniper-routes.mjs).
 */
export async function buildDirectSniperSell({ chainKey, tokenAddress, amountHuman, slippagePct, pool, sellerAddress }) {
  const { executeSniperSell } = await import("./sniper-extras.mjs");
  return captureFirstCall(sellerAddress, chainKey, (signer) =>
    executeSniperSell({ signer, chainKey, tokenAddress, amountHuman, slippagePct, pool }));
}

/**
 * buildDirectSniperBuy — mirrors the /api/sniper/buy route's own dispatch:
 * a chosen AMM pool goes through executeSniperBuy; no pool (curve coin or
 * skipped discovery) goes through buyToken's dispatcher. Buys normally pay
 * msg.value with no approvals, EXCEPT the Robinhood WETH-pool pre-wrap path
 * (WETH.deposit + Permit2), which the capture-signer stages exactly like
 * any other allowance leg.
 */
export async function buildDirectSniperBuy({ chainKey, tokenAddress, ethAmount, slippagePct, pool, buyerAddress }) {
  if (pool?.dex && pool.dex !== "CURVE") {
    const { executeSniperBuy } = await import("./sniper-swap.mjs");
    return captureFirstCall(buyerAddress, chainKey, (signer) =>
      executeSniperBuy({ signer, chainKey, tokenAddress, ethAmount, slippagePct, pool }));
  }
  const { buyToken } = await import("./dip-swap.mjs");
  const { getEthUsd } = await import("./sniper-swap.mjs");
  const ethUsd = await getEthUsd(chainKey).catch(() => 0);
  if (!(ethUsd > 0)) throw new Error("ETH/USD price unavailable — cannot size the buy");
  const usdSize = parseFloat(ethAmount) * ethUsd;
  return captureFirstCall(buyerAddress, chainKey, (signer) =>
    buyToken(signer, tokenAddress, usdSize, { slippagePct, pool: null, chainKey }));
}
