/**
 * curve-buy.mjs — IMD launchpad curve execution path
 *
 * Curve coins are NOT AMM pools: the launchpad hook's beforeSwap consumes the
 * swap whole (both legs — ETH→IMD in the shared pool, IMD→coin on the curve —
 * settle inside one PoolManager unlock). Quoters revert on curve poolKeys and
 * Dexscreener has no pairs for curve coins, so the standard discovery/quote
 * path cannot work here (verified 2026-09-14: findBestV4Pool returns null for
 * ICE; accumulate buys failed with "No WETH pool found").
 *
 * Working calldata shape — decoded from a completed launchpad-UI tx
 * (0.01 ETH → ~423,768 ICE, verified on-chain 2026-09-14):
 *   UR execute(bytes,bytes[],uint256) selector 0x3593564c
 *   commands = 0x060c0f  (SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL)
 *   input[0] = V4_SWAP SWAP_EXACT_IN_SINGLE struct:
 *     poolKey  { currency0: 0x0 (native ETH), currency1: coin,
 *                fee: 60, tickSpacing: 1, hooks: 0x51768F...02888 }
 *     zeroForOne: true, amountIn: ethIn, amountOutMinimum: curve-computed
 *     hookData: abi.encode(recipient wallet)  ← launchpad-specific, REQUIRED;
 *              generic routers never populate it (why Rabby/wallets revert)
 *   msg.value = ethIn
 *
 * Expected-out is computed from curve math (k = virtualImd × virtualCoin) via
 * the indexer's curve state — never a quoter. The slippage guard compares
 * realized vs curve-computed; the hook itself guarantees atomic fill.
 */
import { keccak256, encodeAbiParameters, parseAbiParameters, getAddress, encodeFunctionData, parseAbi } from "viem";

// Launchpad hook — the only hooks address that identifies a curve pool here.
export const LAUNCHPAD_HOOK = getAddress("0x51768F5dA32BA2008304cC81674da51aCb802888");
// Curve pool constants (verified on-chain 2026-09-15: hook.getCurve() returns
// live reserves ONLY for poolId(fee=0, tickSpacing=60) — fee=60/tickSpacing=1
// derives an uninitialized pool and UR execute reverts PoolNotInitialized
// (0x486aa307). The working launchpad-UI tx's swap struct also reads
// (0x0, ICE, 0, 60, hook). The docs' "fee 60" is the fee model description,
// not the poolKey fee field.)
export const CURVE_FEE = 0;
export const CURVE_TICK_SPACING = 60;
const ETH_ADDRESS = "0x0000000000000000000000000000000000000000";

const lower = s => String(s || "").toLowerCase();

/** Derive a curve poolId from the coin address: poolKey is fixed per launchpad. */
export function curvePoolKey(tokenAddress) {
  return {
    currency0: ETH_ADDRESS,
    currency1: getAddress(tokenAddress),
    fee: CURVE_FEE,
    tickSpacing: CURVE_TICK_SPACING,
    hooks: LAUNCHPAD_HOOK,
  };
}

/** poolId = keccak256(abi.encode(poolKey)) — V4's canonical derivation. */
export function deriveCurvePoolId(tokenAddress) {
  const pk = curvePoolKey(tokenAddress);
  const encoded = encodeAbiParameters(
    parseAbiParameters("address, address, uint24, int24, address"),
    [pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks],
  );
  return keccak256(encoded);
}

/**
 * Is this token an IMD-launchpad curve coin? True when the derived curve
 * poolId exists on the launchpad (we accept the structural check + indexer
 * membership; the hook reverts atomically if we're wrong, and the caller's
 * dry-run catches it before funds move).
 */
export function looksLikeCurveCoin(tokenAddress, { knownCoins = null } = {}) {
  const t = lower(tokenAddress);
  if (t === lower("0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7")) return false; // reserve IMD
  if (knownCoins) return knownCoins.has(t);
  return true; // structural fallback: caller narrows with indexer data when available
}

/**
 * Curve-math quote: ETH in → coin out.
 *
 * The hook routes ETH through the 1% ETH/IMD pool then IMD→coin on the curve
 * (k = virtualImd × virtualCoin). Fees: 1% pool, 0.5% creator (ETH leg),
 * 0.5% burn (IMD leg). Approximation used for the MIN-OUT guard (conservative):
 *   ethAfterPoolFee = ethIn × 0.99          (1% LP fee)
 *   imdIn           = ethAfterPoolFee × imdPerEth
 *   coinOut         = virtualCoin − k / (virtualImd + imdIn×0.995)   (0.5% burn)
 * The hook's own accounting is exact; our number only sizes the slippage
 * guard, so err slightly low (use the indexer's imdEthSqrtPriceX96-derived
 * IMD-per-ETH and clamp the final min-out by the user's slippagePct).
 *
 * @param {{virtualImd: bigint, virtualCoin: bigint, imdPerEth: number}} curve
 * @param {bigint} ethAmountWei
 * @param {number} slippagePct
 * @returns {{coinOutRaw: bigint, amountOutMinimum: bigint}}
 */
export function quoteCurveBuy({ virtualImd, virtualCoin, imdPerEth }, ethAmountWei, slippagePct = 3) {
  if (!(imdPerEth > 0)) throw new Error("curve quote needs the ETH/IMD price (imdPerEth)");
  const ethIn = Number(ethAmountWei) / 1e18;
  const imdIn = ethIn * 0.99 * imdPerEth;             // 1% ETH/IMD pool fee
  // virtual reserves arrive in raw wei-scale (1e18); do the k-math in whole
  // tokens so imdIn (whole tokens) is in the same units as virtualImd.
  const viTokens = Number(virtualImd) / 1e18;
  const vcTokens = Number(virtualCoin) / 1e18;
  const k = viTokens * vcTokens;
  const viAfter = viTokens + imdIn * 0.995;           // 0.5% IMD leg burn
  const vcAfter = k / viAfter;
  const coinOut = Math.max(0, vcTokens - vcAfter);
  const coinOutRaw = BigInt(Math.round(coinOut * 1e18));
  const bps = BigInt(Math.round(slippagePct * 100));
  const amountOutMinimum = coinOutRaw - (coinOutRaw * bps) / 10000n;
  return { coinOutRaw, amountOutMinimum };
}

/**
 * Build the Universal Router execute() call for a curve buy.
 * Shape verified against the launchpad UI's own tx (2026-09-14):
 * commands 0x060c0f, SWAP_EXACT_IN_SINGLE with hookData = recipient wallet.
 *
 * @param {object} p
 * @param {string} p.tokenAddress        curve coin
 * @param {bigint} p.ethAmountWei        ETH in
 * @param {bigint} p.amountOutMinimum    curve-computed min out
 * @param {string} p.recipient           buyer's wallet (goes in hookData)
 * @param {string} p.universalRouter     canonical UR address
 * @returns {{call: object, amountOutMinimum: bigint}}
 */
export function buildCurveBuyCall({ tokenAddress, ethAmountWei, amountOutMinimum, recipient, universalRouter }) {
  const poolKey = curvePoolKey(tokenAddress);
  const hookData = encodeAbiParameters(parseAbiParameters("address"), [getAddress(recipient)]);
  // Swap params are HAND-ASSEMBLED to byte-match the launchpad UI's own tx.
  // viem's standard ABI encoding puts a static nested tuple (the poolKey) INLINE —
  // the launchpad instead encodes it as a DYNAMIC tuple (a 0x20 offset head word
  // before the 5 poolKey words). That extra head word is what the V4Router
  // decoder actually reads; without it the swap reverts InvalidEthSender
  // (0x38bbd576) despite being "valid" ABI. Layout (verified by eth_call
  // simulation against mainnet, 2026-09-15):
  //   [0x20 head][currency0][currency1][fee][tickSpacing][hooks]
  //   [zeroForOne=1][amountIn][amountOutMinimum]
  //   [hookData offset=0x120][hookData len=0x20][hookData = recipient]
  const w = (x) => x.toString(16).padStart(64, "0");
  const aw = (a) => getAddress(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const swapParams =
    w(0x20n) +
    aw(poolKey.currency0) + aw(poolKey.currency1) +
    w(BigInt(poolKey.fee)) + w(BigInt(poolKey.tickSpacing)) + aw(poolKey.hooks) +
    w(1n) + w(ethAmountWei) + w(amountOutMinimum) +
    w(0x120n) + w(0x20n) + aw(recipient);
  // SETTLE_ALL(0x0c): currency=ETH(0x0), amount=ethIn (all); TAKE_ALL(0x0f):
  // currency=coin, amount=min-out (the slippage guard + delivery).
  const settleParams = aw(ETH_ADDRESS) + w(ethAmountWei);
  const takeParams = aw(tokenAddress) + w(amountOutMinimum);
  // v4Payload = abi.encode(bytes actions, bytes[] params) hand-built to match:
  //   [actionsOff=0x40][paramsOff=0x80][actions len=3]["060c0f" padded]
  //   [params len=3][off0=0x60][off1=0x200][off2=0x260]
  //   [p0 len=0x180][swapParams][p1 len=0x40][settle][p2 len=0x40][take]
  const v4Payload =
    w(0x40n) + w(0x80n) + w(3n) + "060c0f".padEnd(64, "0") +
    w(3n) + w(0x60n) + w(0x200n) + w(0x260n) +
    w(0x180n) + swapParams +
    w(0x40n) + settleParams +
    w(0x40n) + takeParams;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  return {
    call: {
      address: getAddress(universalRouter),
      // The OUTER execute(bytes,bytes[],uint256) encoding is standard ABI — the
      // launchpad's own tx uses it. Only the INNER swap params needed the
      // non-standard dynamic-tuple poolKey (hand-assembled above), which rides
      // inside inputs[0] as an opaque bytes blob.
      abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
      functionName: "execute",
      args: ["0x10", ["0x" + v4Payload], deadline],
      value: ethAmountWei,
    },
    amountOutMinimum,
  };
}

/**
 * End-to-end curve buy: curve-math quote → UR execute with hookData.
 * Mirrors buyDip()'s contract so the watcher/strategy layer can call it
 * interchangeably for curve coins.
 */
export async function buyCurveCoin(signer, tokenAddress, ethAmountWei, { slippagePct = 3, chainKey = "ethereum", curveState, imdPerEth, universalRouter } = {}) {
  if (!curveState || !imdPerEth || !universalRouter) {
    throw new Error("buyCurveCoin needs { curveState, imdPerEth, universalRouter }");
  }
  // quoteCurveBuy destructures imdPerEth from the same object as the reserves
  // — merge it in (getCurveCoinState returns only the reserves).
  const { coinOutRaw, amountOutMinimum } = quoteCurveBuy(
    { ...curveState, imdPerEth }, ethAmountWei, slippagePct);
  if (coinOutRaw <= 0n) throw new Error(`curve math returned 0 ${tokenAddress} out — refusing a doomed tx`);
  const { call, amountOutMinimum: min } = buildCurveBuyCall({
    tokenAddress, ethAmountWei, amountOutMinimum, recipient: signer.address, universalRouter,
  });
  const txHash = await signer.callContract(call);
  return { txHash, quotedOut: coinOutRaw, amountOutMinimum: min, curve: true };
}

/**
 * Curve-math quote: coin in → IMD out → ETH out (sell runs the buy backwards).
 *   coinAfterFee = coinIn × 0.995           (0.5% burn on the coin leg? — actually
 *   the fee model: 1% pool + 0.5% creator (ETH leg) + 0.5% burn (IMD leg))
 *   imdOut        = k/(vc − coinAfterFee) − vi   (raw IMD units)
 *   ethOut        = (imdAfterFees / imdPerEth) — conservative: ×0.99 for the 1% pool fee on exit
 * Used ONLY for the min-out guard; the hook's accounting is exact.
 */
export function quoteCurveSell({ virtualImd, virtualCoin, imdPerEth }, coinAmountWei, slippagePct = 3) {
  if (!(imdPerEth > 0)) throw new Error("curve sell quote needs imdPerEth");
  const coinIn = Number(coinAmountWei) / 1e18;
  const vcTokens = Number(virtualCoin) / 1e18;
  const viTokens = Number(virtualImd) / 1e18;
  const k = viTokens * vcTokens;
  const coinAfter = coinIn * 0.995;                    // 0.5% burn
  const vcAfter = vcTokens - coinAfter;
  const imdOutTokens = k / vcAfter - viTokens;
  // IMD → ETH at the pool rate, less 1% pool fee (creator fee rides the ETH leg in reverse)
  const ethOut = (imdOutTokens * 0.99) / imdPerEth;
  const ethOutWei = BigInt(Math.max(0, Math.round(ethOut * 1e18)));
  const bps = BigInt(Math.round(slippagePct * 100));
  const minOut = ethOutWei - (ethOutWei * bps) / 10000n;
  return { ethOutWei, minOut };
}

/**
 * Curve SELL: coin → (hook) → ETH in ONE unlock. Mirror of buildCurveBuyCall:
 * same commands 0x060c0f, same poolKey (fee=0, ts=60), zeroForOne=FALSE,
 * amountIn = coin amount, minOut in ETH-wei, hookData = recipient.
 * Requires the vault's token approvals (ERC20 → Permit2 → UR) — sent once.
 * @returns {{txHash, quotedOut}} quotedOut = minOut passed in (ETH wei)
 */
export async function sellCurveCoin(signer, tokenAddress, coinAmountWei, { slippagePct = 3, chainKey = "ethereum", curveState, imdPerEth, universalRouter, minOutWei = null } = {}) {
  if (!curveState || !imdPerEth || !universalRouter) throw new Error("sellCurveCoin needs { curveState, imdPerEth, universalRouter }");
  const { minOut } = minOutWei != null ? { minOut: minOutWei } : quoteCurveSell({ ...curveState, imdPerEth }, coinAmountWei, slippagePct);
  const token = getAddress(tokenAddress);
  const poolKey = curvePoolKey(tokenAddress);
  const w = (x) => x.toString(16).padStart(64, "0");
  const aw = (a) => getAddress(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
  // zeroForOne = false (coin → IMD → ETH), amountIn = coin, minOut = ETH wei
  const swapParams =
    w(0x20n) +
    aw(poolKey.currency0) + aw(poolKey.currency1) +
    w(BigInt(poolKey.fee)) + w(BigInt(poolKey.tickSpacing)) + aw(poolKey.hooks) +
    w(0n) + w(coinAmountWei) + w(minOut) +
    w(0x120n) + w(0x20n) + aw(signer.address);
  const settleParams = aw(token) + w(coinAmountWei);   // settle the COIN side
  const takeParams = aw(ETH_ADDRESS) + w(minOut);      // take ETH
  const v4Payload =
    w(0x40n) + w(0x80n) + w(3n) + "060c0f".padEnd(64, "0") +
    w(3n) + w(0x60n) + w(0x200n) + w(0x260n) +
    w(0x180n) + swapParams + w(0x40n) + settleParams + w(0x40n) + takeParams;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  // Permit2 approval chain (curve sells pull the COIN from the wallet via
  // Permit2; buys pay msg.value and need none). Two one-time txs per coin —
  // see accumulate-debugging/references/curve-execution-imd.md: the FIRST
  // sell without these reverts AllowanceExpired(0) and reads as a dead
  // button. Both are idempotent max-approvals; skip when already covered.
  const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
  const MAX_U256 = 2n ** 256n - 1n;
  const MAX_U160 = (1n << 160n) - 1n;
  const MAX_U48 = (1n << 48n) - 1n;
  const c = (await import("./sniper-swap.mjs")).publicClient(chainKey);
  const erc20Abi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);
  const p2Abi = parseAbi(["function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]);
  const [erc20Allowance, p2] = await Promise.all([
    c.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [signer.address, PERMIT2] }).catch(() => 0n),
    c.readContract({ address: PERMIT2, abi: p2Abi, functionName: "allowance", args: [signer.address, token, getAddress(universalRouter)] }).catch(() => ({ amount: 0n, expiration: 0n })),
  ]);
  if (erc20Allowance < coinAmountWei) {
    const txHash = await signer.callContract({
      address: token,
      abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
      functionName: "approve",
      args: [PERMIT2, MAX_U256],
      copilot: { kind: "approve", product: "sniper", summary: "Approve token → Permit2 (one-time, curve sell prerequisite)" },
    });
    await (await import("./sniper-extras.mjs")).waitForTxReceipt(chainKey, txHash);
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  // viem returns the Permit2 allowance tuple POSITIONALLY ([amount, expiration, nonce]),
  // not named fields (documented in curve-execution-imd.md) — handle both shapes.
  const p2amt = BigInt(Array.isArray(p2) ? (p2[0] ?? 0n) : (p2?.amount ?? 0n));
  const p2exp = BigInt(Array.isArray(p2) ? (p2[1] ?? 0n) : (p2?.expiration ?? 0n));
  if (p2amt < coinAmountWei || p2exp <= nowSec) {
    const txHash = await signer.callContract({
      address: PERMIT2,
      abi: parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration) returns ()"]),
      functionName: "approve",
      args: [token, getAddress(universalRouter), MAX_U160, MAX_U48],
      copilot: { kind: "approve", product: "sniper", summary: "Permit2 → Universal Router allowance (one-time, curve sell prerequisite)" },
    });
    await (await import("./sniper-extras.mjs")).waitForTxReceipt(chainKey, txHash);
  }

  const call = {
    address: getAddress(universalRouter),
    abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
    functionName: "execute",
    args: ["0x10", ["0x" + v4Payload], deadline],
    value: 0n,                                          // sells pay no msg.value
  };
  const txHash = await signer.callContract(call);
  return { txHash, quotedOut: minOut, curve: true, sell: true };
}
