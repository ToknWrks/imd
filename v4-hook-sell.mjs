/**
 * v4-hook-sell.mjs — THE IMD sell path: IMD → native ETH through the hooked
 * ETH/IMD V4 pool (the pool the Uniswap UI trades), executed by the launchpad's
 * hook-router 0x2361…DE85 (NOT the Universal Router — the UR reverts here).
 *
 * Every IMD sell (manual exit in autonomy AND co-pilot, sniper, autosell) goes
 * through executeImdEthSell() via executeSniperSell(). IMD never sells to USDC.
 *
 * Ground truth (verified 2026-09-23/24 against tx 0x6fbc3188…, block 26036791):
 *  - The swap tuple is the STANDARD v4-periphery ExactInputParams
 *    { currencyIn, PathKey[] path, uint256[] maxHopSlippage, amountIn, amountOutMinimum }
 *    — viem's ABI encoder reproduces the on-chain bytes exactly. The "word 16
 *    mystery" was maxHopSlippage[0]; we send an empty array and rely on
 *    amountOutMinimum.
 *  - NO per-trade Permit2 permit is needed: a standing Permit2 allowance
 *    (owner → IMD → hook-router) suffices. execute("0x10", [V4_SWAP]) with the
 *    standing allowance simulates clean at full balance (357,835 gas).
 *  - So the flow is the normal two-layer allowance chain, set ONCE:
 *      IMD.approve(Permit2, max)  →  Permit2.approve(IMD, hookRouter, max, far-future)
 *    both sent through signer.callContract — autonomy signs them itself (no
 *    prompt); co-pilot gets them as staged direct-sign steps.
 */
import { getAddress, parseAbi, parseAbiParameters, encodeAbiParameters } from "viem";

export const IMD = "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7";
export const HOOK_ROUTER = "0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const HOOKED_POOL = {
  poolId: "0x415829f72e9f54531c26eae76f107618540e898a45d6ae35959e143f5faca704",
  currency0: "0x0000000000000000000000000000000000000000", // ETH
  currency1: IMD,
  fee: 10000,
  tickSpacing: 60,
  hooks: "0xc6C965Bd164c483e87d0B550671798e9A3602840",
};
const ETH = "0x0000000000000000000000000000000000000000";
const V4_QUOTER = "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203";
const MAX_UINT160 = 2n ** 160n - 1n;
const MAX_UINT48 = 2n ** 48n - 1n;

export const EXECUTE_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const PERMIT2_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);

export function isImd(tokenAddress, chainKey = "ethereum") {
  return chainKey === "ethereum" && String(tokenAddress).toLowerCase() === IMD.toLowerCase();
}

async function client(chainKey) {
  const { httpClient } = await import("./chains.mjs");
  return httpClient(chainKey);
}

/** ETH out (wei) for selling `amountIn` IMD through the hooked pool. */
export async function quoteImdToEth(amountIn, chainKey = "ethereum") {
  const c = await client(chainKey);
  const { result } = await c.simulateContract({
    address: getAddress(V4_QUOTER),
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{
      poolKey: { currency0: ETH, currency1: getAddress(IMD), fee: HOOKED_POOL.fee, tickSpacing: HOOKED_POOL.tickSpacing, hooks: getAddress(HOOKED_POOL.hooks) },
      zeroForOne: false, // IMD (currency1) → ETH (currency0)
      exactAmount: amountIn,
      hookData: "0x",
    }],
  });
  return result[0];
}

/**
 * Pure calldata builder: execute("0x10", [V4_SWAP]) with actions 0x070b0e =
 * SWAP_EXACT_IN (0x07), SETTLE (0x0b), TAKE (0x0e) — exactly the reference
 * tx's shapes: SETTLE(IMD, 0 = full open delta, payerIsUser = true) and
 * TAKE(ETH, recipient, 0 = full open delta). (SETTLE_ALL/TAKE_ALL are
 * 0x0c/0x0f; their 2-field params reverted in simulation.) Slippage is
 * enforced by amountOutMinimum.
 */
export function buildImdEthSwapCall({ amountIn, minOutWei, recipient, deadlineSec }) {
  const PATH_KEY = "(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)";
  const swap = encodeAbiParameters(
    parseAbiParameters(`(address currencyIn, ${PATH_KEY}[] path, uint256[] maxHopSlippage, uint128 amountIn, uint128 amountOutMinimum)`),
    [{
      currencyIn: getAddress(IMD),
      path: [{ intermediateCurrency: ETH, fee: HOOKED_POOL.fee, tickSpacing: HOOKED_POOL.tickSpacing, hooks: getAddress(HOOKED_POOL.hooks), hookData: "0x" }],
      maxHopSlippage: [],
      amountIn,
      amountOutMinimum: minOutWei,
    }],
  );
  const settle = encodeAbiParameters(parseAbiParameters("address currency, uint256 amount, bool payerIsUser"), [getAddress(IMD), 0n, true]);
  const take = encodeAbiParameters(parseAbiParameters("address currency, address recipient, uint256 amount"), [ETH, getAddress(recipient), 0n]);
  const v4Swap = encodeAbiParameters(parseAbiParameters("bytes actions, bytes[] params"), ["0x070b0e", [swap, settle, take]]);
  return {
    address: getAddress(HOOK_ROUTER),
    abi: EXECUTE_ABI,
    functionName: "execute",
    args: ["0x10", [v4Swap], BigInt(deadlineSec)],
    value: 0n,
  };
}

/**
 * Sell IMD → ETH. signer = the standard interface ({ address, callContract }).
 * Sets the one-time allowance chain if missing (each leg waits for its receipt
 * so the next read sees it), quotes, applies slippage, and swaps.
 */
export async function executeImdEthSell({ signer, chainKey = "ethereum", amountIn, slippagePct = 3 }) {
  if (chainKey !== "ethereum") throw new Error("IMD sells are Ethereum-only");
  if (!(amountIn > 0n)) throw new Error("sell amount must be positive");
  const c = await client(chainKey);
  const owner = getAddress(signer.address);
  const imd = getAddress(IMD);
  const router = getAddress(HOOK_ROUTER);
  const permit2 = getAddress(PERMIT2);

  const bal = await c.readContract({ address: imd, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });
  if (bal < amountIn) throw new Error(`IMD balance ${bal} is below the sell amount ${amountIn}`);

  const quotedOut = await quoteImdToEth(amountIn, chainKey);
  if (!(quotedOut > 0n)) throw new Error("the ETH/IMD pool quoted 0 ETH for this sell — refusing");
  const bps = BigInt(Math.round((Number.isFinite(Number(slippagePct)) && Number(slippagePct) > 0 ? Number(slippagePct) : 3) * 100));
  const minOutWei = quotedOut - (quotedOut * bps) / 10000n;

  const { waitForTxReceipt } = await import("./sniper-extras.mjs");
  const erc20Allowance = await c.readContract({ address: imd, abi: ERC20_ABI, functionName: "allowance", args: [owner, permit2] });
  if (erc20Allowance < amountIn) {
    const tx = await signer.callContract({ address: imd, abi: ERC20_ABI, functionName: "approve", args: [permit2, 2n ** 256n - 1n] });
    await waitForTxReceipt(chainKey, tx);
  }
  const p2 = await c.readContract({ address: permit2, abi: PERMIT2_ABI, functionName: "allowance", args: [owner, imd, router] });
  const p2amt = BigInt(p2[0] ?? 0n);
  const p2exp = BigInt(p2[1] ?? 0n);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (p2amt < amountIn || p2exp <= nowSec + 600n) {
    const tx = await signer.callContract({ address: permit2, abi: PERMIT2_ABI, functionName: "approve", args: [imd, router, MAX_UINT160, MAX_UINT48] });
    await waitForTxReceipt(chainKey, tx);
  }

  const call = buildImdEthSwapCall({ amountIn, minOutWei, recipient: owner, deadlineSec: Math.floor(Date.now() / 1000) + 300 });
  const txHash = await signer.callContract(call);
  await waitForTxReceipt(chainKey, txHash);
  return { txHash, quotedOut, minOutWei };
}
