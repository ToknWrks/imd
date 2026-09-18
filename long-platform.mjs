// long-platform.mjs — Buy/sell support for LONG-platform (long.xyz) stock-paired
// tokens on Robinhood Chain (4663).
//
// Market structure (verified 2026-09-10): a LONG token's only venue is a hooked
// V4 pool {token, stockToken} where stockToken is a Robinhood stock token
// (e.g. ATLANTIS/MU), hook 0x4e34…544. The hook ACCEPTS plain Universal Router
// swaps (eth_estimateGas PASS) but the V4 Quoter REVERTS on hooked pools —
// so quotes come from StateView getSlot0 spot price, never the V4 quoter.
// The stock token has a liquid V3 pool to WETH (MU: fee 3000).
//
// Two transactions per trade (V4 leg, then V3 stock→ETH leg). Not atomic, but
// the intermediate stock token is liquid, so a failed leg is recoverable.
//
// Signer interface matches sniper-extras.mjs:
//   const txHash = await signer.callContract({ address, abi, functionName, args, value })

import {
  createPublicClient, http, parseAbi, parseAbiParameters,
  encodeFunctionData, encodeAbiParameters, getAddress, keccak256,
} from 'viem';
import { getChain } from './chains.mjs';
import { findBestV4Pool, getEthUsdPrice } from './dip-swap.mjs';

const LONG_HOOK = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

const UR_EXECUTE_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const PERMIT2_ABI = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
const ERC20_ABI = parseAbi([
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);
const V3_QUOTER_ABI = parseAbi(['function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint256[] amounts)']);
const V3_ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
  'function multicall(bytes[] data) payable returns (bytes[])',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
]);
const WETH_DEPOSIT_ABI = parseAbi(['function deposit() payable']);
const STATE_VIEW_ABI = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint16 protocolFee, uint16 lpFee)']);

function httpClient(chainKey) {
  const dep = getChain(chainKey);
  return createPublicClient({ transport: http(dep.httpRpc()) });
}

/** Wait for a tx receipt and throw if it reverted (matches repo assertTxSucceeded). */
async function assertTxSucceeded(txHash, chainKey) {
  const c = httpClient(chainKey);
  const receipt = await c.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`[long] tx reverted on-chain (${txHash})`);
  return receipt;
}

// ── detection ────────────────────────────────────────────────────────────────

/** True when `venue` is a V4 pool carrying the LONG platform hook. */
export function isLongVenue(venue) {
  return !!venue && venue.kind === 'v4'
    && typeof venue.poolKey?.hooks === 'string'
    && venue.poolKey.hooks.toLowerCase() === LONG_HOOK.toLowerCase();
}

/**
 * Resolve the LONG venue for a token. Returns the venue object when the
 * token's best V4 pool carries the LONG hook, else null.
 */
export async function findLongVenue(tokenAddress, chainKey = 'robinhood') {
  if (chainKey !== 'robinhood') return null;
  const venue = await findBestV4Pool(tokenAddress, chainKey).catch(() => null);
  return isLongVenue(venue) ? venue : null;
}

/** The pool currency that is NOT `tokenAddress` — the stock token. */
export function longStockToken(venue, tokenAddress) {
  const t = getAddress(tokenAddress).toLowerCase();
  const c0 = getAddress(venue.poolKey.currency0).toLowerCase();
  const c1 = getAddress(venue.poolKey.currency1).toLowerCase();
  if (c0 !== t && c1 !== t) return null;
  return getAddress(c0 === t ? venue.poolKey.currency1 : venue.poolKey.currency0);
}

/** True when `currencyIn` is currency0 of the pool (zeroForOne = true). */
function isZeroForOne(venue, currencyIn) {
  return getAddress(venue.poolKey.currency0).toLowerCase() === getAddress(currencyIn).toLowerCase();
}

// ── pricing / quoting (StateView slot0 — works on hooked pools) ─────────────

/**
 * Spot price of `tokenAddress` in STOCK-token whole units from the hooked
 * pool's slot0. Returns 0 when the pool is uninitialized.
 */
export async function spotPriceInStock(venue, tokenAddress, tokenDecimals = 18, chainKey = 'robinhood') {
  const c = httpClient(chainKey);
  const [sqrtPriceX96] = await c.readContract({
    address: getChain(chainKey).v4.stateView, abi: STATE_VIEW_ABI,
    functionName: 'getSlot0', args: [venue.poolId],
  });
  if (sqrtPriceX96 === 0n) return 0;
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const tokenIs0 = getAddress(venue.poolKey.currency0).toLowerCase() === getAddress(tokenAddress).toLowerCase();
  // sqrtPriceX96 = sqrt(raw1/raw0)·2^96 → whole-unit price flips with the token's side
  const price = tokenIs0
    ? s * s * 10 ** (tokenDecimals - 18)
    : (s > 0 ? 10 ** (18 - tokenDecimals) / (s * s) : 0);
  return price > 0 && Number.isFinite(price) ? price : 0;
}

const _stockEthPool = new Map();

/**
 * Best V3 stock-token/WETH fee tier via QuoterV2 (hooked pools don't affect
 * the V3 leg). Returns { fee, out } for 1e18 raw stock in, or null.
 */
export async function findStockEthPool(stockToken, chainKey = 'robinhood') {
  const key = `${chainKey}:${getAddress(stockToken).toLowerCase()}`;
  if (_stockEthPool.has(key)) return _stockEthPool.get(key);
  const dep = getChain(chainKey);
  const c = httpClient(chainKey);
  const wethHex = getAddress(dep.weth).slice(2).toLowerCase();
  let best = null;
  for (const fee of [100, 500, 3000, 10000]) {
    const path = '0x' + getAddress(stockToken).slice(2).toLowerCase() + fee.toString(16).padStart(6, '0') + wethHex;
    try {
      const { result } = await c.simulateContract({
        address: dep.v3.quoterV2, abi: V3_QUOTER_ABI, functionName: 'quoteExactInput',
        args: [path, 10n ** 18n],
      });
      if (result[0] > 0n && (!best || result[0] > best.out)) best = { fee, out: result[0] };
    } catch { /* tier absent */ }
  }
  _stockEthPool.set(key, best);
  return best;
}

/** V3-quote an exact-in swap (either direction) between two ERC-20s. */
async function quoteV3(tokenIn, tokenOut, amountInRaw, chainKey) {
  const dep = getChain(chainKey);
  const c = httpClient(chainKey);
  const path = '0x' + getAddress(tokenIn).slice(2).toLowerCase() + await bestFeeFor(tokenIn, tokenOut, chainKey) + getAddress(tokenOut).slice(2).toLowerCase();
  const { result } = await c.simulateContract({ address: dep.v3.quoterV2, abi: V3_QUOTER_ABI, functionName: 'quoteExactInput', args: [path, amountInRaw] });
  return result[0];
}

async function bestFeeFor(tokenIn, tokenOut, chainKey) {
  // The stock/WETH pool is keyed by the STOCK token. For a sell (stock→WETH)
  // tokenIn is the stock; for a buy (WETH→stock) tokenOut is. Looking up the
  // wrong side used to return null → wrong fee tier → quote reverted → sell
  // died with "V3 stock→WETH quote returned 0" (ATLANTIS, 2026-09-10).
  const stockPool = await findStockEthPool(tokenIn, chainKey).catch(() => null)
    ?? await findStockEthPool(tokenOut, chainKey).catch(() => null);
  return (stockPool?.fee ?? 3000).toString(16).padStart(6, '0');
}

/**
 * USD price of a LONG token: slot0 spot (token→stock) × stock→WETH V3 price
 * × ETH/USD. Returns 0 when any leg is unavailable.
 */
export async function longTokenPriceUsd(venue, tokenAddress, tokenDecimals = 18, chainKey = 'robinhood') {
  const stock = getAddress(longStockToken(venue, tokenAddress));
  if (!stock) return 0;
  const stockPerToken = await spotPriceInStock(venue, tokenAddress, tokenDecimals, chainKey);
  if (!(stockPerToken > 0)) return 0;
  const pool = await findStockEthPool(stock, chainKey);
  if (!pool || !(pool.out > 0n)) return 0;
  // findStockEthPool quoted 1e18 raw stock → pool.out wei WETH
  const wethPerStock = Number(pool.out) / 1e18;
  const ethUsd = await getEthUsdPrice(chainKey);
  const price = stockPerToken * wethPerStock * ethUsd;
  return price > 0 && Number.isFinite(price) ? price : 0;
}

// ── public quote helpers ─────────────────────────────────────────────────────

/**
 * Full sell quote: slot0 spot for the V4 leg + V3 quote for the exact stock
 * amount out. Returns { stockPerToken, wethOut, stockToken }.
 */
export async function quoteLongSell(venue, tokenAddress, amountHuman, tokenDecimals = 18, chainKey = 'robinhood') {
  const stock = getAddress(longStockToken(venue, tokenAddress));
  const stockPerToken = await spotPriceInStock(venue, tokenAddress, tokenDecimals, chainKey);
  if (!(stockPerToken > 0)) return { stockPerToken: 0, wethOut: 0n, stockToken: stock };
  const amountRaw = BigInt(Math.round(Number(amountHuman) * 10 ** tokenDecimals));
  const stockOutMin = BigInt(Math.round(Number(amountRaw) * spotPriceInStockNumber(stockPerToken)));
  const pool = await findStockEthPool(stock, chainKey);
  if (!pool) return { stockPerToken, wethOut: 0n, stockToken: stock };
  const wethOut = await quoteV3(stock, getAddress(getChain(chainKey).weth), stockOutMin, chainKey).catch(() => 0n);
  return { stockPerToken, wethOut, stockToken: stock };
}
function spotPriceInStockNumber(spot) { return Number(spot); }

/**
 * Buy quote: WETH needed for `usdSize`, the stock that buys, and the token
 * out estimate. Returns { wethIn, stockIn, tokenOutEstimate } (raw units).
 */
export async function quoteLongBuy(venue, tokenAddress, usdSize, ethUsdPrice, tokenDecimals = 18, chainKey = 'robinhood') {
  const stock = getAddress(longStockToken(venue, tokenAddress));
  const pool = await findStockEthPool(stock, chainKey);
  if (!pool) return { wethIn: 0n, stockIn: 0n, tokenOutEstimate: 0n };
  const wethIn = BigInt(Math.round((usdSize / ethUsdPrice) * 1e18));
  // WETH→stock via the V3 pool (reverse path): quote with the same fee tier
  const dep = getChain(chainKey);
  const c = httpClient(chainKey);
  const path = '0x' + getAddress(dep.weth).slice(2).toLowerCase() + pool.fee.toString(16).padStart(6, '0') + stock.slice(2).toLowerCase();
  const stockOut = await c.simulateContract({ address: dep.v3.quoterV2, abi: V3_QUOTER_ABI, functionName: 'quoteExactInput', args: [path, wethIn] })
    .then(r => r.result[0]).catch(() => 0n);
  const spot = await spotPriceInStock(venue, tokenAddress, tokenDecimals, chainKey);
  const tokenOutEstimate = spot > 0 ? BigInt(Math.floor(Number(stockOut) / spot)) : 0n;
  return { wethIn, stockIn: stockOut, tokenOutEstimate };
}

// ── Permit2 / approvals (idempotent) ─────────────────────────────────────────

async function ensurePermit2Chain(signer, token, amountRaw, chainKey) {
  const dep = getChain(chainKey);
  const c = httpClient(chainKey);
  const [erc20Allowance, p2] = await Promise.all([
    c.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [signer.address, PERMIT2] }).catch(() => 0n),
    c.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance', args: [signer.address, token, dep.v4.universalRouter] }).catch(() => ({ amount: 0n, expiration: 0n })),
  ]);
  if (erc20Allowance < amountRaw) {
    const approveHash = await signer.callContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, MAX_UINT160] });
    await assertTxSucceeded(approveHash, chainKey);
    console.log(`[long] approved Permit2 for ${short(token)}`);
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (p2.amount < amountRaw || BigInt(p2.expiration ?? 0) <= nowSec) {
    const p2Hash = await signer.callContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: 'approve', args: [token, dep.v4.universalRouter, MAX_UINT160, MAX_UINT48] });
    await assertTxSucceeded(p2Hash, chainKey);
    console.log(`[long] Permit2 → UR allowance set for ${short(token)}`);
  }
}

async function ensureErc20Approval(signer, token, spender, amountRaw, chainKey) {
  const c = httpClient(chainKey);
  const current = await c.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [signer.address, spender] }).catch(() => 0n);
  if (current < amountRaw) {
    // MUST await the receipt: a swap sent before the approve lands reverts STF
    // (observed live on Robinhood 2026-09-10 — approve and swap raced).
    const approveHash = await signer.callContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, MAX_UINT160] });
    await assertTxSucceeded(approveHash, chainKey);
    console.log(`[long] approved ${short(spender)} for ${short(token)}`);
  }
}

function short(a) { return getAddress(a).slice(0, 10) + '…'; }

// ── V4 swap through the hooked pool (either direction) ───────────────────────

const wn = (x) => BigInt(x).toString(16).padStart(64, '0');
const ad = (a) => getAddress(a).slice(2).toLowerCase().padStart(64, '0');

/** UR execute() calldata: single-hop SWAP_EXACT_IN through the hooked pool. */
function v4SwapCall(venue, currencyIn, currencyOut, amountIn, minOut, recipient, chainKey) {
  const { poolKey } = venue;
  const pathOffset = 5 * 32, emptyFieldOffset = 13 * 32;
  const swapParams = '0x' + wn(0x20) + [
    ad(currencyIn), wn(pathOffset), wn(emptyFieldOffset), wn(amountIn), wn(minOut),
    wn(1), wn(0x20), ad(currencyOut), wn(poolKey.fee), wn(poolKey.tickSpacing), ad(poolKey.hooks), wn(0xa0), wn(0), wn(0),
  ].join('');
  const settleParams = encodeAbiParameters(parseAbiParameters('address currency, uint256 amount, bool payerIsUser'), [currencyIn, 0n, true]);
  const takeParams = encodeAbiParameters(parseAbiParameters('address currency, address recipient, uint256 amount'), [currencyOut, getAddress(recipient), 0n]);
  const payload = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), ['0x070b0e', [swapParams, settleParams, takeParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  return {
    address: getChain(chainKey).v4.universalRouter, abi: UR_EXECUTE_ABI, functionName: 'execute',
    args: ['0x10', [payload], deadline], value: 0n,
  };
}

/**
 * SELL a LONG token (two txs): leg1 V4 token→stock through the hooked pool,
 * leg2 V3 stock→WETH + unwrap to native ETH. On leg2 failure the wallet
 * retains the stock token (liquid, recoverable).
 */
export async function executeLongSell({ signer, chainKey, venue, tokenAddress, amountRaw, tokenDecimals = 18, slippagePct = 3 }) {
  const dep = getChain(chainKey);
  const token = getAddress(tokenAddress);
  const stock = getAddress(longStockToken(venue, token));
  const pool = await findStockEthPool(stock, chainKey);
  if (!pool) throw new Error(`[long] no V3 stock/WETH exit pool for ${short(stock)} — cannot sell`);

  const spot = await spotPriceInStock(venue, token, tokenDecimals, chainKey);
  if (!(spot > 0)) throw new Error('[long] hooked-pool slot0 price unavailable — refusing to sell blind');
  const stockMin = BigInt(Math.floor(Number(amountRaw) * spot * (1 - slippagePct / 100)));
  if (stockMin <= 0n) throw new Error('[long] sell min-out computed to 0 — amount too small');

  await ensurePermit2Chain(signer, token, amountRaw, chainKey);
  const leg1Hash = await signer.callContract(v4SwapCall(venue, token, stock, amountRaw, stockMin, signer.address, chainKey));
  await assertTxSucceeded(leg1Hash, chainKey);
  console.log(`[long] leg1 (V4 token→stock) tx ${leg1Hash}`);

  // leg2: whole stock balance → WETH → native ETH
  const c = httpClient(chainKey);
  const stockBal = await c.readContract({ address: stock, abi: ERC20_ABI, functionName: 'balanceOf', args: [signer.address] });
  if (stockBal <= 0n) throw new Error('[long] no stock balance after leg1 — nothing to exit');
  const wethQuoted = await quoteV3(stock, getAddress(dep.weth), stockBal, chainKey).catch(() => 0n);
  if (wethQuoted <= 0n) throw new Error('[long] V3 stock→WETH quote returned 0 — exit pool dry?');
  const wethMin = wethQuoted - (wethQuoted * BigInt(Math.round(slippagePct * 100))) / 10000n;
  await ensureErc20Approval(signer, stock, dep.v3.swapRouter02, stockBal, chainKey);
  const leg2Hash = await signer.callContract({
    address: dep.v3.swapRouter02, abi: V3_ROUTER_ABI, functionName: 'multicall',
    args: [[
      encodeFunctionData({ abi: V3_ROUTER_ABI, functionName: 'exactInputSingle', args: [{
        tokenIn: stock, tokenOut: dep.weth, fee: pool.fee, recipient: dep.v3.swapRouter02,
        amountIn: stockBal, amountOutMinimum: wethMin, sqrtPriceLimitX96: 0n,
      }] }),
      encodeFunctionData({ abi: V3_ROUTER_ABI, functionName: 'unwrapWETH9', args: [wethMin, signer.address] }),
    ]],
  });
  await assertTxSucceeded(leg2Hash, chainKey);
  console.log(`[long] leg2 (V3 stock→ETH) tx ${leg2Hash}`);
  return { leg1TxHash: leg1Hash, leg2TxHash: leg2Hash, stockToken: stock };
}

/**
 * BUY a LONG token (three txs): wrap ETH→WETH, V3 WETH→stock, V4 stock→token.
 */
export async function executeLongBuy({ signer, chainKey, venue, tokenAddress, usdSize, ethUsdPrice, tokenDecimals = 18, slippagePct = 3 }) {
  const dep = getChain(chainKey);
  const token = getAddress(tokenAddress);
  const stock = getAddress(longStockToken(venue, token));
  const pool = await findStockEthPool(stock, chainKey);
  if (!pool) throw new Error(`[long] no V3 stock/WETH pool for ${short(stock)} — cannot buy`);
  const { wethIn, stockIn, tokenOutEstimate } = await quoteLongBuy(venue, tokenAddress, usdSize, ethUsdPrice, tokenDecimals, chainKey);
  if (wethIn <= 0n || stockIn <= 0n || tokenOutEstimate <= 0n) throw new Error('[long] buy quote returned 0 — liquidity unavailable');

  // pre-flight ETH balance
  const ethBal = await httpClient(chainKey).getBalance({ address: signer.address });
  if (ethBal < wethIn) throw new Error(`[long] insufficient ETH (have ${Number(ethBal) / 1e18}, need ${Number(wethIn) / 1e18})`);

  const wrapTxHash = await signer.callContract({ address: dep.weth, abi: WETH_DEPOSIT_ABI, functionName: 'deposit', value: wethIn });
  await assertTxSucceeded(wrapTxHash, chainKey);
  console.log(`[long] wrapped ${Number(wethIn) / 1e18} ETH → WETH`);

  await ensureErc20Approval(signer, dep.weth, dep.v3.swapRouter02, wethIn, chainKey);
  const leg1Hash = await signer.callContract({
    address: dep.v3.swapRouter02, abi: V3_ROUTER_ABI, functionName: 'exactInputSingle',
    args: [{ tokenIn: dep.weth, tokenOut: stock, fee: pool.fee, recipient: signer.address, amountIn: wethIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
  });
  await assertTxSucceeded(leg1Hash, chainKey);
  console.log(`[long] leg1 (V3 WETH→stock) tx ${leg1Hash}`);

  const c = httpClient(chainKey);
  const stockBal = await c.readContract({ address: stock, abi: ERC20_ABI, functionName: 'balanceOf', args: [signer.address] });
  const spot = await spotPriceInStock(venue, token, tokenDecimals, chainKey);
  if (!(spot > 0)) throw new Error('[long] hooked-pool price unavailable for buy leg2');
  const tokenMin = BigInt(Math.floor(Number(stockBal) / spot * (1 - slippagePct / 100)));
  await ensurePermit2Chain(signer, stock, stockBal, chainKey);
  const leg2Hash = await signer.callContract(v4SwapCall(venue, stock, token, stockBal, tokenMin, signer.address, chainKey));
  await assertTxSucceeded(leg2Hash, chainKey);
  console.log(`[long] leg2 (V4 stock→token) tx ${leg2Hash}`);
  return { wrapTxHash, leg1TxHash: leg1Hash, leg2TxHash: leg2Hash };
}

