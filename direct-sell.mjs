/**
 * direct-sell.mjs — build the curve-sell tx WITHOUT a server signer.
 *
 * 2026-09-21 direct-sign flow: manual sells in co-pilot mode go straight to
 * the user's wallet. This module reuses sellCurveCoin's payload assembly by
 * passing a "capture signer" whose only job is to hand back the built call —
 * then strips the Permit2 legs (allowances already maxed; if they weren't,
 * the user gets the standard approval prompts from the UI, not this path).
 *
 * Returns { to, data, value, gas } — exactly what directSignTx needs.
 */
import { getAddress, parseAbi } from "viem";

export async function buildDirectCurveSell({ tokenAddress, coinAmountWei, sellerAddress, slippagePct = 3, chainKey = "ethereum", curveState, imdPerEth, universalRouter }) {
  if (!curveState || !imdPerEth || !universalRouter) throw new Error("buildDirectCurveSell needs { curveState, imdPerEth, universalRouter }");
  let captured = null;
  const captureSigner = {
    address: getAddress(sellerAddress),
    async callContract(call) { captured = call; throw new Error("CAPTURE-STOP"); },
  };
  const { sellCurveCoin } = await import("./curve-buy.mjs");
  process.on("unhandledRejection", () => {});
  try {
    await sellCurveCoin(captureSigner, tokenAddress, coinAmountWei, { slippagePct, chainKey, curveState, imdPerEth, universalRouter });
  } catch (e) {
    if (!/CAPTURE-STOP/.test(String(e.message))) throw e; // real error (quote/price) — surface it
  }
  if (!captured) throw new Error("could not build the sell payload (allowance leg blocked capture — approve first)");
  const { encodeFunctionData } = await import("viem");
  return {
    to: getAddress(captured.address),
    data: encodeFunctionData({ abi: captured.abi, functionName: captured.functionName, args: captured.args }),
    value: "0",
    gas: 450000,
  };
}
