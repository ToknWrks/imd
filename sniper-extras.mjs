/**
 * Approvals, balances, USD sizing helpers, and token→ETH sells for /sniper.
 */
import { getAddress, parseAbi, parseEther, formatUnits, encodeFunctionData, encodeAbiParameters, parseAbiParameters } from "viem";
import {
  publicClient,
  getNetwork,
  getEthUsd,
  getTokenMeta,
  discoverPools,
} from "./sniper-swap.mjs";
import { findLongVenue, executeLongSell, isLongVenue } from "./long-platform.mjs";
import { findBestV4Pool, findBestV3DollarPool, findBestPool, resolvePoolOverride, getImdPerEth } from "./dip-swap.mjs";
import { getChain } from "./chains.mjs";
import { resolveSigner } from "./signer.mjs";
import { recordGasForTx } from "./gas-ledger.mjs";

const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const V2_SELL_ABI = parseAbi([
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);
const V3_SELL_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  // Unwrap + refund are needed because the V3 sell delivers WETH (tokenOut),
  // not native ETH. Multicall pattern mirrors the buy side in sniper-swap.mjs.
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable returns ()",
  "function refundETH() payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);
const AERO_SELL_ABI = parseAbi([
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, (address from,address to,bool stable,address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
]);

export const USDC = {
  ethereum: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  base: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
};

const V3_QUOTE_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

/**
 * Resolve the best sell venue for a token across all chains, using the
 * dip-watcher's proven chain-aware discovery (the brute-force discoverPools()
 * in sniper-swap.mjs misses Robinhood's non-standard/hooked V4 pools and every
 * dollar-quoted pool — VULT/USDC, SIRIUS/USDG — because it only looks for
 * WETH/ETH pairs).
 *
 * Priority: V4 (Dexscreener → StateView → Initialize-log poolKey) → V3
 * dollar-quoted → V3 WETH-quoted. Ranked by USD liquidity.
 */
async function resolveSellVenue(token, chainKey, poolOverride) {
  // Caller-supplied pool object (Sniper page) wins when it carries a dex tag.
  if (poolOverride?.dex) return poolOverride;
  // String override (watcher's saved pool_address — a V3 address or V4
  // poolId): resolve on-chain via Initialize logs, no Dexscreener needed.
  // This is the reliable path when Dexscreener rate-limits (it does).
  if (typeof poolOverride === "string" && poolOverride.trim() && poolOverride.toLowerCase() !== "auto") {
    const resolved = await resolvePoolOverride(token, poolOverride, chainKey);
    if (resolved.kind === "v4") {
      return {
        dex: "V4",
        label: `Uniswap V4 ${(resolved.fee / 10000).toFixed(2)}% (saved pool)`,
        poolAddress: resolved.poolId,
        fee: resolved.fee,
        tickSpacing: resolved.tickSpacing,
        hooks: resolved.hooks,
        currency0: resolved.currency0,
        currency1: resolved.currency1,
        liquidityUsd: 0,
      };
    }
    return {
      dex: "V3",
      label: `Uniswap V3 ${(Number(resolved.fee) / 10000).toFixed(2)}% (saved pool)`,
      poolAddress: resolved.address,
      fee: Number(resolved.fee),
      token0: resolved.token0,
      token1: resolved.token1,
      liquidityUsd: 0,
    };
  }

  const [v4, v3Dollar] = await Promise.all([
    findBestV4Pool(token, chainKey).catch(() => null),
    findBestV3DollarPool(token, chainKey).catch(() => null),
  ]);
  const candidates = [];
  if (v4) candidates.push({
    dex: "V4",
    label: `Uniswap V4 ${(v4.fee / 10000).toFixed(2)}%${v4.hooks && v4.hooks !== "0x0000000000000000000000000000000000000000" ? " hooked" : ""}`,
    poolAddress: v4.poolId,
    fee: v4.fee,
    tickSpacing: v4.tickSpacing,
    hooks: v4.hooks,
    currency0: v4.currency0,
    currency1: v4.currency1,
    liquidityUsd: v4.liquidityUsd ?? 0,
  });
  if (v3Dollar) candidates.push({
    dex: "V3_DOLLAR",
    label: `Uniswap V3 ${(v3Dollar.fee / 10000).toFixed(2)}% dollar-quoted`,
    poolAddress: v3Dollar.address,
    fee: v3Dollar.fee,
    token0: v3Dollar.token0,
    token1: v3Dollar.token1,
    liquidityUsd: v3Dollar.liquidityUsd ?? 0,
  });
  // WETH-quoted V3 fallback (dip-swap's findBestPool returns liquidity-ranked).
  try {
    const v3 = await findBestPool(token, chainKey);
    if (v3) candidates.push({
      dex: "V3",
      label: `Uniswap V3 ${(Number(v3.fee) / 10000).toFixed(2)}%`,
      poolAddress: v3.address,
      fee: Number(v3.fee),
      token0: v3.token0,
      token1: v3.token1,
      liquidityUsd: 0,
    });
  } catch { /* no WETH pool — dollar/V4 candidates may still exist */ }
  if (!candidates.length) throw new Error(`no sell venue found for ${token} on ${chainKey} (V4, V3 dollar-quoted and V3 WETH-quoted all empty)`);
  candidates.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  // Quote-test the winner before committing to it: Dexscreener sometimes lists
  // V4 pools (LAURA 0x4640a3cb… fee 9000) whose V4 quoter reverts on BOTH
  // directions (0x6190b2b0 — pool ghost-listed or poolKey mismatch). Live case:
  // the ranked winner was unquotable, the sell threw, and the verify flow
  // failed even though a V3 1% pool quoted a 99% round-trip. Demote any
  // candidate whose quoter reverts and return the first one that quotes.
  for (const candidate of candidates) {
    if (candidate.dex !== "V4") return candidate; // V3 paths quote at send time — nothing to pre-test
    const ok = await quoteV4CandidateSellable(token, candidate, chainKey).catch(() => false);
    if (ok) return candidate;
    console.log(`[sell] V4 candidate ${candidate.label} failed its quoter check — falling back to the next venue`);
  }
  throw new Error(`no sell venue found for ${token} on ${chainKey} (every candidate failed its quote check)`);
}

/** True when the V4 quoter can price a sell through this pool. A revert here
 *  means the swap will fail exactly the same way — better to find out now and
 *  use the next venue than throw mid-sell. */
async function quoteV4CandidateSellable(token, candidate, chainKey) {
  const n = getNetwork(chainKey);
  const tokenIs0 = String(candidate.currency0).toLowerCase() === String(token).toLowerCase();
  const { result } = await publicClient(chainKey).simulateContract({
    address: n.v4Quoter,
    abi: parseAbi(["function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)"]),
    functionName: "quoteExactInputSingle",
    args: [{
      poolKey: { currency0: candidate.currency0, currency1: candidate.currency1, fee: Number(candidate.fee), tickSpacing: Number(candidate.tickSpacing), hooks: candidate.hooks || ZERO },
      zeroForOne: tokenIs0, exactAmount: 1_000_000_000_000n, hookData: "0x",
    }],
  });
  return result[0] > 0n;
}

/** Token→dollar V3 sell: SwapRouter02.exactInputSingle delivers the chain's
 *  dollar token (USDC/USDG) — no unwrap needed, unlike the WETH path. */
async function executeV3DollarSell({ signer, chainKey, tokenAddress, amountIn, slippagePct, venue, dollarAddress }) {
  const n = getNetwork(chainKey);
  const c = publicClient(chainKey);
  const token = getAddress(tokenAddress);
  const { result } = await c.simulateContract({
    address: n.v3Quoter,
    abi: V3_QUOTE_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: token, tokenOut: dollarAddress, amountIn, fee: Number(venue.fee), sqrtPriceLimitX96: 0n }],
  });
  const quotedOut = result[0];
  if (quotedOut <= 0n) throw new Error("V3 dollar sell quote returned 0 — no liquidity in that direction");
  const amountOutMinimum = minOut(quotedOut, slippagePct);

  const current = await c.readContract({
    address: token, abi: ERC20_ABI, functionName: "allowance",
    args: [signer.address, n.v3Router],
  });
  if (current < amountIn) {
    const tx = await signer.callContract({
      address: token, abi: ERC20_ABI, functionName: "approve",
      args: [n.v3Router, 2n ** 256n - 1n],
    });
    await waitForTxReceipt(chainKey, tx); // approval must be mined before the swap can pull
  }
  const txHash = await signer.callContract({
    address: n.v3Router,
    abi: V3_SELL_ABI,
    functionName: "exactInputSingle",
    args: [{
      tokenIn: token,
      tokenOut: dollarAddress,
      fee: Number(venue.fee),
      recipient: signer.address, // ERC-20 out — deliver straight to the wallet
      amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    }],
  });
  await waitForTxReceipt(chainKey, txHash);
  return { txHash, quotedOut, amountOutMinimum };
}

function spenders(n) {
  const list = [
    { key: "v2", label: "Uniswap V2 router", address: n.v2Router },
    { key: "v3", label: "Uniswap V3 router", address: n.v3Router },
    { key: "v4", label: "Universal Router (V4)", address: n.v4Router },
  ];
  if (n.aeroRouter) list.push({ key: "aero", label: "Aerodrome router", address: n.aeroRouter });
  return list;
}

export async function getQuoteContext(chainKey, owner) {
  return getQuoteContextMulti(chainKey, owner ? [owner] : null);
}

/**
 * Quote context with the balance summed across ALL provided wallets (SCW +
 * browser EOA, 2026-09-20) — a single-wallet read understated the sniper's
 * ETH/USD balances whenever funds sat on the other side of the custody
 * boundary. wallets=null → zeros (no owner context).
 */
export async function getQuoteContextMulti(chainKey, wallets) {
  const c = publicClient(chainKey);
  const ethUsd = await getEthUsd(chainKey);
  let ethBal = 0;
  let usdcBal = 0;
  if (wallets?.length) {
    // USDC map has no Robinhood entry — read the chain registry's dollar
    // token (USDG on 4663) with its real decimals instead of crashing.
    const usdcAddress = USDC[chainKey]?.address ?? getChain(chainKey).dollar;
    const usdcDecimals = USDC[chainKey]?.decimals ?? getChain(chainKey).dollarDecimals ?? 6;
    const [weis, usdcRaws] = await Promise.all([
      Promise.all(wallets.map((a) => c.getBalance({ address: a }).catch(() => 0n))),
      Promise.all(wallets.map((a) => c.readContract({
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [a],
      }).catch(() => 0n))),
    ]);
    ethBal = weis.reduce((s, w) => s + Number(w ?? 0n), 0) / 1e18;
    usdcBal = usdcRaws.reduce((s, r) => s + Number(r ?? 0n), 0) / 10 ** usdcDecimals;
  }
  // Live ETH/IMD pool rate (60s server cache in dip-swap) — the sniper's IMD
  // base-denomination converts through this. Non-critical display data: a
  // failure yields 0 and the UI shows an em-dash, it never blocks a buy.
  const imdPerEth = await getImdPerEth(chainKey).catch(() => 0);
  return { chain: chainKey, ethUsd, ethBalance: ethBal, usdcBalance: usdcBal, ethUsdValue: ethBal * ethUsd, imdPerEth };
}

export function usdToEth(usd, ethUsd) {
  if (!(ethUsd > 0)) throw new Error("ETH/USD unavailable");
  return Number(usd) / ethUsd;
}

/**
 * Live position for one token: balance + USD value + ETH/USD, shared by the
 * /api/sniper/position endpoint and the P/L card so both always agree.
 */
export async function getSniperPosition(chainKey, tokenAddress, { walletOverride = null, walletOverrides = null } = {}) {
  // walletOverride / walletOverrides (2026-09-18/19): per-user read wallets.
  // Holdings can SPLIT between the SCW (app-signed trades) and the browser
  // EOA (launchpad/curve buys) — sum every wallet provided.
  const wallets = walletOverrides ?? (walletOverride ? [walletOverride] : null);
  const address = wallets?.[0] || (await resolveSigner(chainKey)).address;
  const balLists = await Promise.all(
    (wallets ?? [address]).map((w) => getTokenBalance(chainKey, tokenAddress, w))
  );
  const summedRaw = balLists.reduce((a, b) => a + BigInt(b.raw), 0n);
  const bal = { ...balLists[0], raw: summedRaw.toString(), formatted: Number(summedRaw) / 10 ** Number(balLists[0].decimals) };
  const ethUsd = await getEthUsd(chainKey);
  let valueUsd = 0;
  if (bal.formatted > 0) {
    const disc = await discoverPools(chainKey, tokenAddress, "0.01");
    const best = disc.pools[0];
    if (best) {
      // AMM venue: value via the 0.01-ETH probe quote.
      const tokensForPoint01 = Number(best.quotedOut) / 10 ** Number(bal.decimals);
      if (tokensForPoint01 > 0) valueUsd = (bal.formatted / tokensForPoint01) * 0.01 * ethUsd;
    } else {
      // CURVE COIN (IMD launchpad): no AMM pools to probe. Value via curve math:
      // coin → IMD (indexer reserves) → ETH (imdPerEth) → USD (ethUsd).
      const { getCurveCoinState, getImdPerEth } = await import("./dip-swap.mjs");
      const curveState = await getCurveCoinState(tokenAddress, chainKey).catch(() => null);
      const imdPerEth = curveState ? await getImdPerEth(chainKey).catch(() => null) : null;
      if (curveState && imdPerEth > 0) {
        // curve price in IMD per coin = virtualImd / virtualCoin; IMD price = ethUsd / imdPerEth
        const priceImd = Number(curveState.virtualImd) / Number(curveState.virtualCoin);
        const priceUsd = (priceImd / imdPerEth) * ethUsd;
        if (priceUsd > 0) valueUsd = bal.formatted * priceUsd;
      }
    }
  }
  return { ...bal, valueUsd, ethUsd };
}

export async function getTokenBalance(chainKey, tokenAddress, owner) {
  const c = publicClient(chainKey);
  const token = getAddress(tokenAddress);
  const [raw, meta] = await Promise.all([
    c.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
    getTokenMeta(chainKey, token),
  ]);
  return {
    raw: raw.toString(),
    formatted: Number(formatUnits(raw, meta.decimals ?? 18)),
    decimals: meta.decimals,
    symbol: meta.symbol,
  };
}

export async function getApprovals(chainKey, owner, tokenAddress) {
  const n = getNetwork(chainKey);
  const c = publicClient(chainKey);
  const tokens = [
    { key: "weth", symbol: "WETH", address: n.weth, decimals: 18 },
    { key: "usdc", symbol: "USDC", address: USDC[chainKey].address, decimals: 6 },
  ];
  if (tokenAddress) {
    const meta = await getTokenMeta(chainKey, tokenAddress);
    tokens.push({ key: "token", symbol: meta.symbol || "TOKEN", address: getAddress(tokenAddress), decimals: meta.decimals });
  }
  const rows = [];
  for (const tok of tokens) {
    for (const sp of spenders(n)) {
      const raw = await c.readContract({
        address: tok.address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner, sp.address],
      }).catch(() => 0n);
      rows.push({
        token: tok.symbol,
        tokenAddress: tok.address,
        spender: sp.label,
        spenderAddress: sp.address,
        allowance: raw.toString(),
        approved: raw > 10n ** 18n || (tok.decimals === 6 && raw > 10n ** 12n),
      });
    }
  }
  return rows;
}

export async function approveSpender(signer, tokenAddress, spender) {
  return signer.callContract({
    address: getAddress(tokenAddress),
    abi: ERC20_ABI,
    functionName: "approve",
    args: [getAddress(spender), 2n ** 256n - 1n],
  });
}

function minOut(quoted, slippagePct) {
  const q = BigInt(quoted);
  const bps = BigInt(Math.round(Number(slippagePct) * 100));
  return q - (q * bps) / 10000n;
}

/**
 * Quote a sell's proceeds in ETH (best-effort) for the dust-guard.
 * V4: quoter with token→currency direction. V3/V2: discoverPools' 0.01-ETH
 * probe scaled linearly. Returns null when it can't produce a number.
 */
async function quoteSellProceedsEth(chainKey, token, amountInRaw, chosen) {
  if (chosen?.dex === "V4" && chosen.currency0 && chosen.currency1) {
    const n = getNetwork(chainKey);
    const tokenIs0 = String(chosen.currency0).toLowerCase() === String(token).toLowerCase();
    const { result } = await publicClient(chainKey).simulateContract({
      address: n.v4Quoter,
      abi: parseAbi(["function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)"]),
      functionName: "quoteExactInputSingle",
      args: [{
        poolKey: { currency0: chosen.currency0, currency1: chosen.currency1, fee: Number(chosen.fee), tickSpacing: Number(chosen.tickSpacing), hooks: chosen.hooks || ZERO },
        zeroForOne: tokenIs0, exactAmount: amountInRaw, hookData: "0x",
      }],
    });
    const quoteCurrency = tokenIs0 ? chosen.currency1 : chosen.currency0;
    const ethUsd = await getEthUsd(chainKey).catch(() => 0);
    return proceedsInEth({ chainKey, quoteOut: result[0], quoteCurrency, ethUsd });
  }
  return null; // V3/V2 path: guard falls back to the fair-value probe below
}

/**
 * Wait for a transaction receipt and throw if it reverted. Every sell-path
 * send used to return a hash immediately, so reverted swaps/approvals were
 * recorded as successes (gas burned, position unchanged, UI said OK).
 * Robinhood blocks average ~37s — 4 min covers ~6 blocks.
 */
export async function waitForTxReceipt(chainKey, txHash, timeoutMs = 240_000) {
  const receipt = await publicClient(chainKey).waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs });
  recordGasForTx(txHash, chainKey).catch(() => {}); // gas ledger — best effort, never blocks the flow
  if (receipt.status !== "success") throw new Error(`transaction reverted on-chain: ${txHash}`);
  return receipt;
}

const V4_SELL_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;
const PERMIT2_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const V4_SELL_QUOTER_ABI = parseAbi([
  // Single-struct params shape — identical to dip-swap.mjs's V4_QUOTER_ABI
  // (the shape proven live by the buy path). The flat 4-arg form mis-encodes.
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

/**
 * Build (not send) the V4 sell calldata: quote via the V4 quoter, derive
 * minOut, encode the UR execute() payload. Shared by executeV4Sell (real send)
 * and scripts/test-sell-execution.mjs (dry-run) so the dry-run can never
 * silently drift from what a real sell sends.
 */
export async function buildV4SellCall({ chainKey, tokenAddress, amountIn, slippagePct, pool, recipient = ZERO }) {
  const n = getNetwork(chainKey);
  const c = publicClient(chainKey);
  const token = getAddress(tokenAddress);
  const key = {
    currency0: pool.currency0,
    currency1: pool.currency1,
    fee: Number(pool.fee),
    tickSpacing: Number(pool.tickSpacing),
    hooks: pool.hooks || ZERO,
  };
  const tokenIs0 = key.currency0.toLowerCase() === token.toLowerCase();
  const quoteCurrency = tokenIs0 ? key.currency1 : key.currency0;

  const { result } = await c.simulateContract({
    address: n.v4Quoter,
    abi: V4_SELL_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{
      poolKey: { ...key },
      zeroForOne: tokenIs0,
      exactAmount: amountIn,
      hookData: "0x",
    }],
  });
  const quotedOut = result[0];
  if (quotedOut <= 0n) throw new Error("V4 sell quote returned 0 — no liquidity in that direction");
  const amountOutMinimum = minOut(quotedOut, slippagePct);

  // SWAP_EXACT_IN path payload — IV4Router.ExactInputParams has an
  // unpublished trailing empty field beyond the four named members (see
  // dip-swap.mjs buildV4ExactInPathPayload for the full derivation).
  const wn = (x) => BigInt(x).toString(16).padStart(64, "0");
  const addr = (a) => a.slice(2).toLowerCase().padStart(64, "0");
  const HEAD_WORDS = 5;
  const PATH_WORDS = 8;
  const pathOffset = HEAD_WORDS * 32;
  const emptyFieldOffset = pathOffset + PATH_WORDS * 32;
  const tuple = [
    addr(token), wn(pathOffset), wn(emptyFieldOffset), wn(amountIn), wn(amountOutMinimum),
    wn(1), wn(0x20), addr(quoteCurrency), wn(key.fee), wn(key.tickSpacing), addr(key.hooks), wn(0xa0), wn(0), wn(0),
  ];
  const swapParams = "0x" + wn(0x20) + tuple.join("");
  // The single path element is the OTHER currency (the quote asset) —
  // quoteCurrency is tokenIs0 ? currency1 : currency0, computed above.

  const settleParams = encodeAbiParameters(parseAbiParameters("address currency, uint256 amount, bool payerIsUser"), [token, 0n, true]);
  const takeParams = encodeAbiParameters(parseAbiParameters("address currency, address recipient, uint256 amount"), [quoteCurrency, getAddress(recipient), 0n]);
  const v4Payload = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), ["0x070b0e", [swapParams, settleParams, takeParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  return {
    call: {
      address: n.v4Router,
      abi: V4_SELL_ABI,
      functionName: "execute",
      args: ["0x10", [v4Payload], deadline],
      value: 0n,
    },
    quotedOut,
    amountOutMinimum,
  };
}

/**
 * V4 SELL: token → pool quote asset (native ETH or ERC-20), single hop,
 * through the Universal Router's hooked-pool-safe SWAP_EXACT_IN path shape
 * (actions 0x070b0e = SWAP_EXACT_IN/SETTLE/TAKE). Mirrors mm-swap.mjs's
 * executeMmSell — the MM bot's proven V4 sell — adapted to dip-swap's
 * pool objects. `pool` MUST be a V4 pool (dex === "V4") carrying
 * currency0/currency1/fee/tickSpacing/hooks.
 */
async function executeV4Sell({ signer, chainKey, tokenAddress, amountIn, slippagePct, pool }) {
  const n = getNetwork(chainKey);
  const c = publicClient(chainKey);
  const token = getAddress(tokenAddress);

  const { call, quotedOut, amountOutMinimum } = await buildV4SellCall({ chainKey, tokenAddress: token, amountIn, slippagePct, pool, recipient: signer.address });

  // Permit2 chain (same as the V4 buy path): ERC-20 approve PERMIT2, then a
  // Permit2 allowance for the Universal Router. Both idempotent.
  const [erc20Allowance, p2] = await Promise.all([
    c.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [signer.address, PERMIT2] }),
    c.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance", args: [signer.address, token, n.v4Router] }),
  ]);
  if (erc20Allowance < amountIn) {
    const tx = await signer.callContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [PERMIT2, MAX_UINT160] });
    await waitForTxReceipt(chainKey, tx); // approval must be mined before the swap can pull
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (p2.amount < amountIn || BigInt(p2.expiration ?? 0) <= nowSec) {
    const tx = await signer.callContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: "approve", args: [token, n.v4Router, MAX_UINT160, MAX_UINT48] });
    await waitForTxReceipt(chainKey, tx);
  }

  const txHash = await signer.callContract(call);
  await waitForTxReceipt(chainKey, txHash);
  return { txHash, quotedOut, amountOutMinimum };
}

/**
 * ETH-equivalent of a sell's quoted proceeds. V4/V3_DOLLAR sells can deliver
 * the chain's dollar token (USDC/USDG) rather than WETH — proceeds are
 * recorded in ETH so buys (eth_spent) and sells (eth_received) share one
 * unit for net cost-basis math. ETH/WETH proceeds pass through unchanged.
 */
function proceedsInEth({ chainKey, quoteOut, quoteCurrency, ethUsd }) {
  if (quoteOut == null) return null;
  const n = getNetwork(chainKey);
  const isDollar = n.dollar && quoteCurrency &&
    String(quoteCurrency).toLowerCase() === String(n.dollar).toLowerCase();
  if (!isDollar) return Number(quoteOut) / 1e18; // native-ETH-quoted pool
  if (!(Number(ethUsd) > 0)) return null;        // can't convert without ETH/USD
  return (Number(quoteOut) / 10 ** Number(getChain(chainKey).dollarDecimals)) / Number(ethUsd);
}

export async function executeSniperSell({ signer, chainKey, tokenAddress, amountHuman, slippagePct = 3, pool }) {
  const n = getNetwork(chainKey);
  const token = getAddress(tokenAddress);
  const meta = await getTokenMeta(chainKey, token);
  const amountIn = BigInt(Math.round(Number(amountHuman) * 10 ** Number(meta.decimals)));
  if (amountIn <= 0n) throw new Error("sell amount must be positive");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  // IMD-launchpad curve coins: no AMM venue to resolve — the hook consumes the
  // swap whole. Sell through the curve (zeroForOne=false, ETH min-out guard).
  // Trigger: explicit CURVE pool marker, or any ethereum-chain sell with no
  // usable pool where the indexer lists the token as a curve coin.
  if (pool?.dex === "CURVE" || (chainKey === "ethereum" && !pool?.dex)) {
    const { getCurveCoinState, getImdPerEth } = await import("./dip-swap.mjs");
    const curveState = await getCurveCoinState(token, chainKey).catch(() => null);
    if (curveState) {
      const imdPerEth = await getImdPerEth(chainKey).catch(() => null);
      if (!imdPerEth) throw new Error("curve sell: can't price IMD (ETH/IMD pool unavailable)");
      const dep = getChain(chainKey);
      const { sellCurveCoin } = await import("./curve-buy.mjs");
      const res = await sellCurveCoin(signer, token, amountIn, {
        slippagePct, chainKey, curveState, imdPerEth, universalRouter: dep.v4.universalRouter,
      });
      return { txHash: res.txHash, label: "IMD bonding curve (sell)", dex: "CURVE", amountIn: amountIn.toString() };
    }
  }

  // LONG-platform tokens (long.xyz): their hooked V4 pool rejects the V4
  // quoter and discoverPools sees no venue — route through the platform
  // path (V4 token→stock, then V3 stock→ETH). Detection first tries
  // Dexscreener, but when it's rate-limited the watcher's SAVED poolId
  // (string override) is resolved on-chain via Initialize logs instead —
  // poolKey recovery needs no Dexscreener at all.
  if (chainKey === "robinhood" && !pool?.dex) {
    let longVenue = await findLongVenue(token, chainKey);
    if (!longVenue && typeof pool === "string" && pool.trim() && pool.toLowerCase() !== "auto") {
      const resolved = await resolvePoolOverride(token, pool, chainKey).catch(() => null);
      if (resolved && isLongVenue(resolved)) longVenue = resolved;
    }
    if (longVenue) {
      const res = await executeLongSell({ signer, chainKey, venue: longVenue, tokenAddress: token, amountRaw: amountIn, tokenDecimals: Number(meta.decimals), slippagePct });
      return { txHash: res.leg1TxHash, leg2TxHash: res.leg2TxHash, label: "LONG platform (token→stock→ETH)", dex: "LONG", amountIn: amountIn.toString() };
    }
  }

  let chosen = pool;
  if (!chosen?.dex) {
    // Chain-aware venue resolution (V4 incl. hooked/non-standard pools, V3
    // dollar-quoted, V3 WETH-quoted — ranked by USD liquidity). The saved
    // pool string (watcher.pool_address) resolves on-chain, no Dexscreener.
    chosen = await resolveSellVenue(token, chainKey, typeof pool === "string" ? pool : null);
  }
  // V3_DOLLAR sells deliver the chain's dollar token (USDC/USDG) instead of
  // WETH — e.g. VULT/USDC on mainnet, SIRIUS/USDG on Robinhood. Routed before
  // the generic V3/WETH branch; no unwrap needed for an ERC-20 out.
  if (chosen.dex === "V3_DOLLAR") {
    const dollar = getChain(chainKey).dollar;
    if (!dollar) throw new Error(`no dollar token configured for ${chainKey} — cannot route a dollar-quoted sell`);
    const res = await executeV3DollarSell({ signer, chainKey, tokenAddress: token, amountIn, slippagePct, venue: chosen, dollarAddress: dollar });
    const ethUsd = await getEthUsd(chainKey).catch(() => 0);
    return { txHash: res.txHash, label: chosen.label, dex: chosen.dex, amountIn: amountIn.toString(), quotedOut: res.quotedOut.toString(),
      ethReceived: proceedsInEth({ chainKey, quoteOut: res.quotedOut, quoteCurrency: dollar, ethUsd }) };
  }

  // Proceeds sanity guard: quote the sell and refuse when proceeds are dust.
  // Live case: OPAI's launcher hook charged ~100% dynamic fee on early sells
  // — the swap "succeeded" and delivered 1.3e-15 ETH for a ~$30 position.
  // A quoter that says dust = the pool will pay dust; abort BEFORE sending.
  // Baseline: the 0.01-ETH probe quote discoverPools already ran for this
  // token/venue family — compare the sell's implied proceeds against the
  // position's fair value implied by that probe.
  const sanity = await quoteSellProceedsEth(chainKey, token, amountIn, chosen).catch(() => null);
  if (sanity != null) {
    // Fair value: what this amount would be worth at the price implied by a
    // 0.01-ETH reference swap (discoverPools' probe), i.e. linear extrapolation.
    let fairEth = null;
    try {
      const disc = await discoverPools(chainKey, token, "0.01");
      const match = disc.pools.find((p) => p.dex === chosen.dex) || disc.pools[0];
      const tokensPerPoint01 = Number(match?.quotedOut ?? 0) / 10 ** Number(meta.decimals);
      if (tokensPerPoint01 > 0) fairEth = 0.01 * (Number(amountHuman) / (tokensPerPoint01 / 0.01));
      if (fairEth != null && Number.isFinite(fairEth) && fairEth > 0) {
        const ratio = sanity / fairEth;
        if (ratio < 0.5) {
          throw new Error(
            `sell refused: quoted proceeds ${sanity.toFixed(6)} ETH are ${Math.round(ratio * 100)}% of fair value ${fairEth.toFixed(6)} ETH — the pool's hook/fee is consuming the swap (dynamic sell tax). Selling here donates the tokens.`
          );
        }
      }
    } catch (e) {
      if (String(e.message).startsWith("sell refused:")) throw e;
      // probe failure is non-fatal — never block a sell because a probe hiccuped
    }
  }

  // V4 sells route through the dedicated path (Permit2 allowance chain, UR
  // SWAP_EXACT_IN shape) — they bypass the ERC-20 router-approval flow below
  // and compute their own quote/min-out from the V4 quoter.
  if (chosen.dex === "V4") {
    if (!chosen.currency0 || !chosen.currency1) {
      throw new Error("chosen V4 pool is missing currency0/currency1 — re-run Check liquidity to refresh the pool object");
    }
    const res = await executeV4Sell({ signer, chainKey, tokenAddress: token, amountIn, slippagePct, pool: chosen });
    const quoteCurrency = String(chosen.currency0).toLowerCase() === token.toLowerCase() ? chosen.currency1 : chosen.currency0;
    const ethUsd = await getEthUsd(chainKey).catch(() => 0);
    return { txHash: res.txHash, label: chosen.label, dex: chosen.dex, amountIn: amountIn.toString(), quotedOut: res.quotedOut.toString(),
      ethReceived: proceedsInEth({ chainKey, quoteOut: res.quotedOut, quoteCurrency, ethUsd }) };
  }

  const allowanceSpender = chosen.dex === "AERODROME" ? n.aeroRouter
    : chosen.dex === "V3" ? n.v3Router
    : n.v2Router;

  const current = await publicClient(chainKey).readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [signer.address, allowanceSpender],
  });
  if (current < amountIn) {
    await signer.callContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [allowanceSpender, 2n ** 256n - 1n],
    });
  }

  let quotedEth = 0n;
  try {
    const disc = await discoverPools(chainKey, token, "0.01");
    const match = disc.pools.find((p) => p.dex === chosen.dex) || disc.pools[0];
    const tokensForPoint01 = Number(match.quotedOut) / 10 ** Number(meta.decimals);
    if (tokensForPoint01 > 0) quotedEth = parseEther(String((Number(amountHuman) / tokensForPoint01) * 0.01));
  } catch {}
  const amountOutMin = quotedEth > 0n ? minOut(quotedEth, slippagePct) : 0n;

  let txHash;
  if (chosen.dex === "V3") {
    // V3 sells deliver WETH (tokenOut = WETH). DO NOT unwrap on chains whose
    // WETH9 withdraw() is broken — on Robinhood (4663) withdraw() burns the
    // WETH and the native ETH VANISHES (verified 2026-09-12: wrap 1e12 wei →
    // withdraw → ETH down by gas only, the wrapped dust destroyed). The
    // unwrapWETH9-in-multicall shape silently burned every V3 WETH-quoted
    // sell's proceeds on that chain. Fix: recipient = WALLET, single-call
    // exactInputSingle, no unwrap — the wallet keeps WETH as the proceeds
    // (spendable ERC-20; deposit/withdraw quirks don't affect transfers).
    const useUnwrap = chainKey !== "robinhood";
    if (useUnwrap) {
      // Canonical path: router holds the WETH, unwrap delivers native ETH.
      txHash = await signer.callContract({
        address: n.v3Router,
        abi: V3_SELL_ABI,
        functionName: "multicall",
        args: [[
          encodeFunctionData({
            abi: V3_SELL_ABI, functionName: "exactInputSingle",
            args: [{
              tokenIn: token,
              tokenOut: n.weth,
              fee: Number(chosen.fee),
              recipient: n.v3Router, // router holds WETH for the unwrap step
              amountIn,
              amountOutMinimum: amountOutMin,
              sqrtPriceLimitX96: 0n,
            }],
          }),
          encodeFunctionData({ abi: V3_SELL_ABI, functionName: "unwrapWETH9", args: [amountOutMin, signer.address] }),
        ]],
      });
      await waitForTxReceipt(chainKey, txHash);
      return { txHash, label: chosen.label, dex: chosen.dex, amountIn: amountIn.toString() };
    }
    // Robinhood-style chain: deliver WETH straight to the wallet.
    txHash = await signer.callContract({
      address: n.v3Router,
      abi: V3_SELL_ABI,
      functionName: "exactInputSingle",
      args: [{
        tokenIn: token,
        tokenOut: n.weth,
        fee: Number(chosen.fee),
        recipient: signer.address,
        amountIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0n,
      }],
    });
    await waitForTxReceipt(chainKey, txHash);
    return { txHash, label: chosen.label + " (WETH out)", dex: chosen.dex, amountIn: amountIn.toString(), quotedOut: amountOutMin, wethOut: true };
  } else if (chosen.dex === "AERODROME") {
    txHash = await signer.callContract({
      address: n.aeroRouter,
      abi: AERO_SELL_ABI,
      functionName: "swapExactTokensForETH",
      args: [
        amountIn,
        amountOutMin,
        [{ from: token, to: n.weth, stable: !!chosen.stable, factory: n.aeroFactory }],
        signer.address,
        deadline,
      ],
    });
    await waitForTxReceipt(chainKey, txHash);
  } else {
    txHash = await signer.callContract({
      address: n.v2Router,
      abi: V2_SELL_ABI,
      functionName: "swapExactTokensForETH",
      args: [amountIn, amountOutMin, [token, n.weth], signer.address, deadline],
    });
    await waitForTxReceipt(chainKey, txHash);
  }

  // Proceeds for the generic path are the pre-swap quote estimate (also used
  // for amountOutMin) — the swap itself returns ETH via unwrap/swapExactTokensForETH.
  return { txHash, label: chosen.label, dex: chosen.dex, amountIn: amountIn.toString(),
    ethReceived: quotedEth > 0n ? Number(quotedEth) / 1e18 : null };
}

/** Read-only venue resolution exposed for sell-probe.mjs (honeypot guard). */
export const resolveSellVenueForProbe = resolveSellVenue;
