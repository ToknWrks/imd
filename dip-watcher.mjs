#!/usr/bin/env node
/**
 * dip-watcher.mjs — always-on daemon.
 *
 * Watches the Uniswap V3 pool for every active dip_watchers row via a
 * WebSocket subscription to its Swap events. When a sell crosses the
 * watcher's $ threshold (and it's not cooling down), it market-buys via
 * dip-swap.mjs using whatever signer is configured (signer.mjs).
 *
 * Re-checks the DB for added/removed/toggled watchers every 30s and
 * subscribes/unsubscribes accordingly — no restart needed to pick up changes
 * made from the dashboard.
 *
 * Run manually: node dip-watcher.mjs
 * Runs on PM2 in production — see ecosystem.config.cjs.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { formatUnits, parseAbi } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env ─────────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = resolve(__dirname, ".env");
  try {
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "").replace(/\s*#.*$/, "");
    }
  } catch {}
}

loadEnv();

const {
  getActiveDipWatchers, getActiveAccumulationStrategies, getAccumulationStrategy, isDipWatcherCoolingDown,
  getDipWatcher, touchDipWatcherTriggered, insertDipTrade, updateWalletPosition, reserveStrategyExecution, finalizeStrategyExecution, setAccumulationStrategyActive,
} = await import("./db.mjs");
const { findBestPool, getEthUsdPrice, buyToken, findBestV4Pool, findBestAerodromePool, findBestV3DollarPool, isDollarQuotedV3, resolvePoolOverride } = await import("./dip-swap.mjs");
const { computeWalletPosition } = await import("./wallet-position.mjs");
const { resolveSigner, resolveSignerUser } = await import("./signer.mjs");

/** Per-user signer: autonomy users get their own session-key SCW; co-pilot users enqueue browser approvals. */
async function userSigner(watcher, chainKey) {
  return resolveSignerUser(watcher.user_id || "system", chainKey);
}
const { getWsClient, getChain } = await import("./chains.mjs");
const { startWatchdog, stopWatchdog, noteWsActivity } = await import("./ws-watchdog.mjs");
const { alert } = await import("./notify.mjs");

// Trade-failure alerting: dedupe key includes the watcher so repeated failures
// on different tokens all surface, but the same token's flapping doesn't spam.
function alertTradeFailure(watcher, kind, message) {
  const chainKey = watcher.chain || "ethereum";
  alert(`trade-fail-${watcher.id}-${kind}`, `🚨 ${kind} FAILED — ${label(watcher)} on ${chainKey}: ${message}`, { force: /insufficient/i.test(message) });
}

const SWAP_EVENT_ABI = parseAbi([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

// V4 Swap event (PoolManager singleton): id = poolId, amounts are int128
const V4_SWAP_EVENT_ABI = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

// Aerodrome Slipstream (CL) pools use the Uniswap-V3 Swap shape (verified live
// against LAPTOP's $1.6M USDC/LAPTOP pool 0x99cf…: USDC in positive, token out
// negative — same pool-perspective deltas as V4).
const AERO_CL_SWAP_ABI = SWAP_EVENT_ABI;

// Aerodrome V2-style pools (verified via 4byte + live logs on LAPTOP's
// USDC/LAPTOP volatile pair): sender+to indexed, in/out amounts in data.
const AERO_V2_SWAP_ABI = parseAbi([
  "event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount0Out, uint256 amount1In, uint256 amount1Out)",
]);

const RECONCILE_MS = 30_000;
const POSITION_REFRESH_MS = 15 * 60_000; // wallet-position scans are the heaviest HTTP consumers (transfer history) — 15min after the 2026-09-11 Alchemy rate-limit (was 5min)

// watcherId → { unwatch, poolAddress }
const active = new Map();

async function subscribe(watcher) {
  const chainKey = watcher.chain || "ethereum";
  const dep = getChain(chainKey);

  // Manual pool override wins when set (V3 address or V4 poolId); otherwise
  // auto-discover, preferring V4 when it has meaningful liquidity.
  let override = null;
  if (watcher.pool_address) {
    override = await resolvePoolOverride(watcher.contract_address, watcher.pool_address, chainKey);
  }
  const v4Pool = override ?? await findBestV4Pool(watcher.contract_address, chainKey).catch(() => null);
  // Curve coins have no V3 pool at all — findBestPool throws; catch so the
  // watcher stays alive (scheduled buys don't need a WS subscription).
  const v3Pool = override ?? (dep.v3.factory === "0x0000000000000000000000000000000000000000" ? null : await findBestPool(watcher.contract_address, chainKey).catch(() => null));
  // A V3 pool with zero in-range liquidity can't produce sell signals (and a
  // buy through it reverts) — treat it as absent so dollar-quoted V3 pools
  // and other venues can compete (VULT: WETH pools empty, USDC pool live).
  const v3PoolLive = v3Pool && v3Pool.liquidity > 0n ? v3Pool : null;
  const aeroPool = override ? null : await findBestAerodromePool(watcher.contract_address, chainKey).catch(() => null);
  // Dollar-quoted V3 pool (e.g. VULT's USDC/VULT on mainnet) — watch it when
  // the WETH-side V3 pool is missing or has no live liquidity.
  const v3DollarPool = (override || (v3PoolLive)) ? null : await findBestV3DollarPool(watcher.contract_address, chainKey).catch(() => null);

  // Pick the deepest venue by USD liquidity — a $1.6M Aerodrome CL pool
  // dwarfs Uniswap's $100k V4s, and sells happen where the liquidity is.
  // Dollar-quoted V3 pools compete too (VULT's USDC/VULT case).
  const venues = [v4Pool, v3PoolLive, aeroPool, v3DollarPool].filter(Boolean);
  const best = venues.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];

  if (best?.kind === "v3" && isDollarQuotedV3(best, watcher.contract_address, chainKey)) {
    // Dollar-quoted V3 pool won — sells there are USDC-denominated.
    const unwatch = getWsClient(chainKey).watchContractEvent({
      address: best.address,
      abi: SWAP_EVENT_ABI,
      eventName: "Swap",
      onLogs: (logs) => {
        noteWsActivity(chainKey);
        for (const log of logs) {
          handleV3DollarSwap(watcher, best, log).catch((e) =>
            console.error(`[dip-watcher] ${label(watcher)}: error handling V3 dollar-pool swap — ${e.message}`)
          );
        }
      },
      onError: (e) => console.error(`[dip-watcher] ${label(watcher)}: V3 dollar-pool subscription error — ${e.message}`),
    });
    active.set(watcher.id, { unwatch, poolAddress: best.address, chainKey });
    console.log(`[dip-watcher] Watching ${label(watcher)} on ${dep.name} — V3 dollar pool ${best.address} (fee ${best.fee}, liq $${Math.round(best.liquidityUsd).toLocaleString()}) — threshold $${watcher.threshold_usd}, buy $${watcher.buy_amount_usd}`);
    return;
  }

  if (best?.kind === "aero-cl" || best?.kind === "aero-v2") {
    // Aerodrome pool won on liquidity — subscribe to its pool directly.
    const isCl = best.kind === "aero-cl";
    const unwatch = getWsClient(chainKey).watchContractEvent({
      address: best.address,
      abi: isCl ? AERO_CL_SWAP_ABI : AERO_V2_SWAP_ABI,
      eventName: "Swap",
      onLogs: (logs) => {
        noteWsActivity(chainKey);
        for (const log of logs) {
          handleAeroSwap(watcher, best, log).catch((e) =>
            console.error(`[dip-watcher] ${label(watcher)}: error handling Aerodrome swap — ${e.message}`)
          );
        }
      },
      onError: (e) => console.error(`[dip-watcher] ${label(watcher)}: Aerodrome subscription error — ${e.message}`),
    });
    active.set(watcher.id, { unwatch, poolAddress: best.address, chainKey });
    const liqTxt = Math.round(best.liquidityUsd ?? 0).toLocaleString();
    console.log(`[dip-watcher] Watching ${label(watcher)} on ${dep.name} — Aerodrome ${isCl ? "Slipstream" : "V2"} ${best.quote === "usdc" ? "USDC" : "WETH"} pool ${best.address} (${isCl ? `fee ${best.fee}, ts ${best.tickSpacing}` : best.stable ? "stable" : "volatile"}, liq $${liqTxt}) — threshold $${watcher.threshold_usd}, buy $${watcher.buy_amount_usd}`);
    return;
  }

  if (v4Pool && v4Pool.kind === "v4" && (!v3Pool || v4Pool.liquidityUsd > 1000 || override)) {
    // V4 exists and has meaningful liquidity — subscribe to PoolManager Swap
    // events filtered to this poolId. A sell of the watched token is
    // token-in/ETH-out → amount1 > 0 when currency1 is the token.
    const unwatch = getWsClient(chainKey).watchContractEvent({
      address: dep.v4.poolManager,
      abi: V4_SWAP_EVENT_ABI,
      eventName: "Swap",
      args: { id: v4Pool.poolId },
      onLogs: (logs) => {
        noteWsActivity(chainKey);
        for (const log of logs) {
          handleV4Swap(watcher, v4Pool, log).catch((e) =>
            console.error(`[dip-watcher] ${label(watcher)}: error handling V4 swap — ${e.message}`)
          );
        }
      },
      onError: (e) => console.error(`[dip-watcher] ${label(watcher)}: V4 subscription error — ${e.message}`),
    });
    active.set(watcher.id, { unwatch, poolAddress: v4Pool.poolId, chainKey });
    console.log(`[dip-watcher] Watching ${label(watcher)} on ${dep.name} — V4 pool ${v4Pool.poolId} (fee ${v4Pool.fee}, tickSpacing ${v4Pool.tickSpacing}, liq $${Math.round(v4Pool.liquidityUsd).toLocaleString()}) — threshold $${watcher.threshold_usd}, buy $${watcher.buy_amount_usd}`);
    return;
  }

  if (!v3Pool) throw new Error(`no V4 pool found and V3 is unavailable on ${dep.name}`);
  const pool = v3Pool;
  const wethIsToken0 = pool.token0.toLowerCase() === dep.weth.toLowerCase();

  const unwatch = getWsClient(chainKey).watchContractEvent({
    address: pool.address,
    abi: SWAP_EVENT_ABI,
    eventName: "Swap",
    onLogs: (logs) => {
      noteWsActivity(chainKey);
      for (const log of logs) {
        handleSwap(watcher, wethIsToken0, log).catch((e) =>
          console.error(`[dip-watcher] ${label(watcher)}: error handling swap — ${e.message}`)
        );
      }
    },
    onError: (e) => console.error(`[dip-watcher] ${label(watcher)}: subscription error — ${e.message}`),
  });

  active.set(watcher.id, { unwatch, poolAddress: pool.address, chainKey });
  console.log(`[dip-watcher] Watching ${label(watcher)} on ${dep.name} — pool ${pool.address} (fee ${pool.fee}) — threshold $${watcher.threshold_usd}, buy $${watcher.buy_amount_usd}`);
}

function label(watcher) {
  return watcher.symbol ?? watcher.contract_address;
}

/**
 * V4 swap handler. `pool` is the resolved V4 pool (currency0 = native ETH,
 * currency1 = the watched token). In V4 Swap events, deltas are from the
 * pool's perspective (positive = pool pays out): a token sell shows up as
 * ETH in → token out, i.e. amount0 > 0 and amount1 < 0.
 */
async function handleV4Swap(watcher, pool, log) {
  watcher = getDipWatcher(watcher.id) ?? watcher;
  const chainKey = watcher.chain || "ethereum";
  const dep = getChain(chainKey);
  const { amount0, amount1 } = log.args;
  // The watched token can sit on either side of the pool (ETH pools always
  // have ETH as currency0, but dollar-quote pools like SIRIUS/USDG on
  // Robinhood have the token as currency0). A SELL = quote currency enters
  // the pool (delta > 0) while the token leaves it (delta < 0).
  const tokenL = watcher.contract_address.toLowerCase();
  const c0 = pool.currency0?.toLowerCase();
  const c1 = pool.currency1?.toLowerCase();
  let quoteDelta, tokenDelta, quoteIsDollar = false;
  if (c0 === tokenL.toLowerCase()) {
    tokenDelta = amount0; quoteDelta = amount1;
    quoteIsDollar = c1 === dep.dollar.toLowerCase();
  } else if (c1 === tokenL.toLowerCase()) {
    tokenDelta = amount1; quoteDelta = amount0;
    quoteIsDollar = c0 === dep.dollar.toLowerCase();
  } else {
    return; // watched token isn't in this pool
  }
  if (!(quoteDelta > 0n && tokenDelta < 0n)) return;

  // Sell size in USD: dollar-quote pools are already USD-denominated (the
  // chain's dollar ≈ $1); ETH pools convert via Chainlink.
  let sellUsd;
  if (quoteIsDollar) {
    sellUsd = Number(quoteDelta) / 10 ** dep.dollarDecimals;
  } else {
    const ethIn = Number(quoteDelta) / 1e18;
    const ethUsd = await getEthUsdPrice(chainKey);
    sellUsd = ethIn * ethUsd;
  }

  const strategy = getAccumulationStrategy(watcher.id);
  const activeStrategy = strategy?.active && strategy.end_at > new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "") ? strategy : null;
  if (sellUsd < (activeStrategy?.dip_threshold_usd ?? watcher.threshold_usd)) return;

  if (isDipWatcherCoolingDown(watcher.id)) {
    console.log(`[dip-watcher] ${label(watcher)}: $${sellUsd.toFixed(0)} V4 sell detected but cooling down — skipping`);
    return;
  }

  const buyAmountUsd = activeStrategy ? activeStrategy.dip_buy_usd : watcher.buy_amount_usd;
  let reservation = null;
  if (activeStrategy) {
    try {
      reservation = reserveStrategyExecution({
        strategyId: activeStrategy.id, watcherId: watcher.id, kind: "dip", amountUsd: buyAmountUsd,
      });
    } catch (e) {
      console.log(`[dip-watcher] ${label(watcher)}: Zooch dip skipped — ${e.message}`);
      return;
    }
  }

  console.log(`[dip-watcher] 🚨 ${label(watcher)}: $${sellUsd.toFixed(0)} V4 sell (tx ${log.transactionHash}) — buying $${buyAmountUsd}`);
  touchDipWatcherTriggered(watcher.id);

  try {
    const signer = await userSigner(watcher, chainKey);
    // Route by venue: dollar-quote pools are paid with the chain's dollar
    // token (no ETH side to settle); everything else pays with native ETH
    // (buyToken does the ETH pre-flight balance guard internally).
    const { txHash, quotedOut, eth_spent } = await buyToken(signer, watcher.contract_address, buyAmountUsd, {
      slippagePct: watcher.slippage_pct, pool, chainKey,
    });
    const tokenAmount = Number(formatUnits(quotedOut, watcher.decimals ?? 18));

    if (reservation) {
      finalizeStrategyExecution({ executionId: reservation.executionId, txHash });
      reservation = null;
    }
    insertDipTrade({
      watcher_id: watcher.id,
      sell_tx_hash: log.transactionHash,
      sell_usd: sellUsd,
      buy_tx_hash: txHash,
      eth_spent: eth_spent ?? null,
      token_amount: tokenAmount,
      price_usd: tokenAmount > 0 ? buyAmountUsd / tokenAmount : null,
      strategy_id: activeStrategy?.id,
      execution_kind: activeStrategy ? "dip" : null,
    });
    console.log(`[dip-watcher] ✅ ${label(watcher)}: bought via V4 — tx ${txHash}`);
  } catch (e) {
    if (reservation) finalizeStrategyExecution({ executionId: reservation.executionId, error: e.message });
    console.error(`[dip-watcher] ❌ ${label(watcher)}: V4 buy failed — ${e.message}`);
    alertTradeFailure(watcher, "V4 dip buy", e.message);
    insertDipTrade({
      watcher_id: watcher.id,
      sell_tx_hash: log.transactionHash,
      sell_usd: sellUsd,
      strategy_id: activeStrategy?.id,
      execution_kind: activeStrategy ? "dip" : null,
      status: "error",
      error: e.message,
    });
  }
}

/**
 * V3 dollar-quoted pool handler (e.g. VULT's USDC/VULT on mainnet). A SELL of
 * the watched token = token enters the pool (positive delta, pool receives)
 * while the quote pays OUT (negative delta, pool pays). USD size comes
 * straight from the quote delta — no Chainlink conversion needed. Buys
 * execute via buyToken() → buyDipMultiHop (ETH→dollar→token).
 */
async function handleV3DollarSwap(watcher, pool, log) {
  watcher = getDipWatcher(watcher.id) ?? watcher;
  const chainKey = watcher.chain || "ethereum";
  const dep = getChain(chainKey);
  const { amount0, amount1 } = log.args;

  const quoteDelta = pool.token0.toLowerCase() === dep.dollar.toLowerCase() ? amount0 : amount1;
  const tokenDelta = pool.token0.toLowerCase() === dep.dollar.toLowerCase() ? amount1 : amount0;
  // V3 pool perspective: positive = pool receives. Sell = token in (+), quote out (−).
  if (!(tokenDelta > 0n && quoteDelta < 0n)) return;
  const sellUsd = Number(-quoteDelta) / 10 ** dep.dollarDecimals;

  const strategy = getAccumulationStrategy(watcher.id);
  const activeStrategy = strategy?.active && strategy.end_at > new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "") ? strategy : null;
  if (sellUsd < (activeStrategy?.dip_threshold_usd ?? watcher.threshold_usd)) return;

  if (isDipWatcherCoolingDown(watcher.id)) {
    console.log(`[dip-watcher] ${label(watcher)}: $${sellUsd.toFixed(0)} dollar-pool sell detected but cooling down — skipping`);
    return;
  }

  const buyAmountUsd = activeStrategy ? activeStrategy.dip_buy_usd : watcher.buy_amount_usd;
  let reservation = null;
  if (activeStrategy) {
    try {
      reservation = reserveStrategyExecution({
        strategyId: activeStrategy.id, watcherId: watcher.id, kind: "dip", amountUsd: buyAmountUsd,
      });
    } catch (e) {
      console.log(`[dip-watcher] ${label(watcher)}: Zooch dip skipped — ${e.message}`);
      return;
    }
  }

  console.log(`[dip-watcher] 🚨 ${label(watcher)}: $${sellUsd.toFixed(0)} dollar-pool sell (tx ${log.transactionHash}) — buying $${buyAmountUsd}`);
  touchDipWatcherTriggered(watcher.id);

  try {
    const signer = await userSigner(watcher, chainKey);
    // Route by venue: buyToken picks the multi-hop (ETH→dollar→token) path
    // automatically for a V3 dollar-quoted venue.
    const { txHash, quotedOut, eth_spent } = await buyToken(signer, watcher.contract_address, buyAmountUsd, { slippagePct: watcher.slippage_pct, chainKey });
    const tokenAmount = Number(formatUnits(quotedOut, watcher.decimals ?? 18));

    if (reservation) {
      finalizeStrategyExecution({ executionId: reservation.executionId, txHash });
      reservation = null;
    }
    insertDipTrade({
      watcher_id: watcher.id,
      sell_tx_hash: log.transactionHash,
      sell_usd: sellUsd,
      buy_tx_hash: txHash,
      eth_spent: eth_spent ?? null,
      token_amount: tokenAmount,
      price_usd: tokenAmount > 0 ? buyAmountUsd / tokenAmount : null,
      strategy_id: activeStrategy?.id,
      execution_kind: activeStrategy ? "dip" : null,
    });
    console.log(`[dip-watcher] ✅ ${label(watcher)}: bought (dollar-pool signal) — tx ${txHash}`);
  } catch (e) {
    if (reservation) finalizeStrategyExecution({ executionId: reservation.executionId, error: e.message });
    console.error(`[dip-watcher] ❌ ${label(watcher)}: buy failed — ${e.message}`);
    alertTradeFailure(watcher, "dip buy", e.message);
    insertDipTrade({
      watcher_id: watcher.id,
      sell_tx_hash: log.transactionHash,
      sell_usd: sellUsd,
      strategy_id: activeStrategy?.id,
      execution_kind: activeStrategy ? "dip" : null,
      status: "error",
      error: e.message,
    });
  }
}

/**
 * Aerodrome swap handler (both Slipstream/CL and V2 pools). A SELL of the
 * watched token = quote currency enters the pool while the token leaves it:
 *   - CL pools: V3-style int256 deltas, pool perspective (positive = pool
 *     pays out) — same semantics as the V4 handler.
 *   - V2 pools: uint256 in/out amounts per side.
 * Buy execution still routes through buyToken() (Uniswap V4/V3 — the $5-10
 * clip sizes are trivial for Uniswap's liquidity on the same token).
 */
async function handleAeroSwap(watcher, pool, log) {
  watcher = getDipWatcher(watcher.id) ?? watcher;
  const chainKey = watcher.chain || "ethereum";
  const dep = getChain(chainKey);

  let quoteIn, tokenOut;
  if (pool.kind === "aero-cl") {
    const { amount0, amount1 } = log.args;
    const quoteDelta = pool.token0IsQuote ? amount0 : amount1;
    const tokenDelta = pool.token0IsQuote ? amount1 : amount0;
    // CL deltas are pool-perspective: quote in = negative, token out = positive.
    if (!(-quoteDelta > 0n && tokenDelta > 0n)) return;
    quoteIn = -quoteDelta;
    tokenOut = tokenDelta;
  } else {
    // V2 shapes: a SELL of the watched token sends the token INTO the pool
    // (tokenIn) and pays the quote OUT of it (quoteOut).
    const { amount0In, amount0Out, amount1In, amount1Out } = log.args;
    const quoteOutRaw = pool.token0IsQuote ? amount0Out : amount1Out;
    const tokenInRaw = pool.token0IsQuote ? amount1In : amount0In;
    if (!(quoteOutRaw > 0n && tokenInRaw > 0n)) return;
    quoteIn = quoteOutRaw; // USD size = quote paid out by the pool
    tokenOut = tokenInRaw;
  }

  // Sell size in USD: dollar-quoted pools are already USD (USDC ≈ $1); WETH
  // pools convert via Chainlink.
  let sellUsd;
  if (pool.quote === "usdc") {
    sellUsd = Number(quoteIn) / 1e6;
  } else {
    sellUsd = (Number(quoteIn) / 1e18) * await getEthUsdPrice(chainKey);
  }

  const strategy = getAccumulationStrategy(watcher.id);
  const activeStrategy = strategy?.active && strategy.end_at > new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "") ? strategy : null;
  if (sellUsd < (activeStrategy?.dip_threshold_usd ?? watcher.threshold_usd)) return;

  if (isDipWatcherCoolingDown(watcher.id)) {
    console.log(`[dip-watcher] ${label(watcher)}: $${sellUsd.toFixed(0)} Aerodrome sell detected but cooling down — skipping`);
    return;
  }

  const buyAmountUsd = activeStrategy ? activeStrategy.dip_buy_usd : watcher.buy_amount_usd;
  let reservation = null;
  if (activeStrategy) {
    try {
      reservation = reserveStrategyExecution({
        strategyId: activeStrategy.id, watcherId: watcher.id, kind: "dip", amountUsd: buyAmountUsd,
      });
    } catch (e) {
      console.log(`[dip-watcher] ${label(watcher)}: Zooch dip skipped — ${e.message}`);
      return;
    }
  }

  console.log(`[dip-watcher] 🚨 ${label(watcher)}: $${sellUsd.toFixed(0)} Aerodrome sell (tx ${log.transactionHash}) — buying $${buyAmountUsd}`);
  touchDipWatcherTriggered(watcher.id);

  try {
    const signer = await userSigner(watcher, chainKey);
    // Execute via the standard Uniswap routing (buyToken) — smallest-slippage
    // venue for a small clip; the Aerodrome pool is only the *signal*.
    const { txHash, quotedOut, eth_spent } = await buyToken(signer, watcher.contract_address, buyAmountUsd, { slippagePct: watcher.slippage_pct, chainKey });
    const tokenAmount = Number(formatUnits(quotedOut, watcher.decimals ?? 18));

    if (reservation) {
      finalizeStrategyExecution({ executionId: reservation.executionId, txHash });
      reservation = null;
    }
    insertDipTrade({
      watcher_id: watcher.id,
      sell_tx_hash: log.transactionHash,
      sell_usd: sellUsd,
      buy_tx_hash: txHash,
      eth_spent: eth_spent ?? null,
      token_amount: tokenAmount,
      price_usd: tokenAmount > 0 ? buyAmountUsd / tokenAmount : null,
      strategy_id: activeStrategy?.id,
      execution_kind: activeStrategy ? "dip" : null,
    });
    console.log(`[dip-watcher] ✅ ${label(watcher)}: bought (Aerodrome signal) — tx ${txHash}`);
  } catch (e) {
    if (reservation) finalizeStrategyExecution({ executionId: reservation.executionId, error: e.message });
    console.error(`[dip-watcher] ❌ ${label(watcher)}: buy failed — ${e.message}`);
    alertTradeFailure(watcher, "dip buy", e.message);
    insertDipTrade({
      watcher_id: watcher.id,
      sell_tx_hash: log.transactionHash,
      sell_usd: sellUsd,
      strategy_id: activeStrategy?.id,
      execution_kind: activeStrategy ? "dip" : null,
      status: "error",
      error: e.message,
    });
  }
}

async function handleSwap(watcher, wethIsToken0, log) {
  // Subscriptions retain their initial watcher object; reload mutable strategy
  // settings so an applied Zooch review takes effect without a daemon restart.
  watcher = getDipWatcher(watcher.id) ?? watcher;
  const chainKey = watcher.chain || "ethereum";
  const { amount0, amount1 } = log.args;
  const wethDelta = wethIsToken0 ? amount0 : amount1;
  const tokenDelta = wethIsToken0 ? amount1 : amount0;

  // A sell of the watched token: pool pays WETH out (negative) while
  // receiving the token in (positive).
  if (!(wethDelta < 0n && tokenDelta > 0n)) return;

  const ethOut = Number(-wethDelta) / 1e18;
  const ethUsd = await getEthUsdPrice(chainKey);
  const sellUsd = ethOut * ethUsd;

  const strategy = getAccumulationStrategy(watcher.id);
  const activeStrategy = strategy?.active && strategy.end_at > new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "") ? strategy : null;
  if (sellUsd < (activeStrategy?.dip_threshold_usd ?? watcher.threshold_usd)) return;

  if (isDipWatcherCoolingDown(watcher.id)) {
    console.log(`[dip-watcher] ${label(watcher)}: $${sellUsd.toFixed(0)} sell detected but cooling down — skipping`);
    return;
  }

  const buyAmountUsd = activeStrategy ? activeStrategy.dip_buy_usd : watcher.buy_amount_usd;
  let reservation = null;
  if (activeStrategy) {
    try {
      reservation = reserveStrategyExecution({
        strategyId: activeStrategy.id, watcherId: watcher.id, kind: "dip", amountUsd: buyAmountUsd,
      });
    } catch (e) {
      console.log(`[dip-watcher] ${label(watcher)}: Zooch dip skipped — ${e.message}`);
      return;
    }
  }

  console.log(`[dip-watcher] 🚨 ${label(watcher)}: $${sellUsd.toFixed(0)} sell (tx ${log.transactionHash}) — buying $${buyAmountUsd}`);
  touchDipWatcherTriggered(watcher.id);

  try {
    const signer = await userSigner(watcher, chainKey);
    // Route by venue (V3 path is always ETH-paid; buyToken does the balance guard)
    const { txHash, quotedOut, eth_spent } = await buyToken(signer, watcher.contract_address, buyAmountUsd, { slippagePct: watcher.slippage_pct, chainKey });
    const tokenAmount = Number(formatUnits(quotedOut, watcher.decimals ?? 18));

    if (reservation) {
      finalizeStrategyExecution({ executionId: reservation.executionId, txHash });
      reservation = null;
    }
    insertDipTrade({
      watcher_id: watcher.id,
      sell_tx_hash: log.transactionHash,
      sell_usd: sellUsd,
      buy_tx_hash: txHash,
      eth_spent: eth_spent ?? null,
      token_amount: tokenAmount,
      price_usd: tokenAmount > 0 ? buyAmountUsd / tokenAmount : null,
      strategy_id: activeStrategy?.id,
      execution_kind: activeStrategy ? "dip" : null,
    });
    console.log(`[dip-watcher] ✅ ${label(watcher)}: bought — tx ${txHash}`);
  } catch (e) {
    if (reservation) finalizeStrategyExecution({ executionId: reservation.executionId, error: e.message });
    console.error(`[dip-watcher] ❌ ${label(watcher)}: buy failed — ${e.message}`);
    alertTradeFailure(watcher, "dip buy", e.message);
    insertDipTrade({
      watcher_id: watcher.id,
      sell_tx_hash: log.transactionHash,
      sell_usd: sellUsd,
      strategy_id: activeStrategy?.id,
      execution_kind: activeStrategy ? "dip" : null,
      status: "error",
      error: e.message,
    });
  }
}

async function runScheduledBuys() {
  for (const strategy of getActiveAccumulationStrategies()) {
    if (strategy.next_scheduled_at > new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")) continue;
    const chainKey = strategy.chain || "ethereum";
    let reservation;
    try {
      reservation = reserveStrategyExecution({
        strategyId: strategy.id,
        watcherId: strategy.watcher_id,
        kind: "scheduled",
        amountUsd: strategy.base_buy_usd,
        scheduledFor: strategy.next_scheduled_at,
      });
      const signer = await userSigner(strategy, chainKey);
      // Route by venue: dollar-quote pools pay with the chain's dollar token.
      const { txHash, quotedOut, eth_spent } = await buyToken(signer, strategy.contract_address, strategy.base_buy_usd, { slippagePct: strategy.slippage_pct, chainKey });
      const tokenAmount = Number(formatUnits(quotedOut, strategy.decimals ?? 18));
      finalizeStrategyExecution({ executionId: reservation.executionId, txHash });
      reservation = null;
      insertDipTrade({
        watcher_id: strategy.watcher_id,
        buy_tx_hash: txHash,
        eth_spent: eth_spent ?? null,
        token_amount: tokenAmount,
        price_usd: tokenAmount > 0 ? strategy.base_buy_usd / tokenAmount : null,
        strategy_id: strategy.id,
        execution_kind: "scheduled",
      });
      console.log(`[dip-watcher] ✅ ${label(strategy)}: scheduled Zooch buy — tx ${txHash}`);
    } catch (e) {
      if (reservation) finalizeStrategyExecution({ executionId: reservation.executionId, error: e.message });
      console.error(`[dip-watcher] ❌ ${label(strategy)}: scheduled Zooch buy failed — ${e.message}`);
      alertTradeFailure(strategy, "scheduled buy", e.message);
      // A fully-committed budget never frees itself — without this guard the
      // scheduler retried every tick (30s) and logged an error row each time
      // (1,212 IF rows overnight, 2026-09-13). Deactivate once, loudly.
      if (/budget exhausted|allocation exhausted/.test(e.message)) {
        setAccumulationStrategyActive(strategy.watcher_id, 0);
        console.error(`[dip-watcher] ⏸ ${label(strategy)}: budget fully committed — strategy auto-paused (re-plan to continue)`);
        insertDipTrade({
          watcher_id: strategy.watcher_id,
          strategy_id: strategy.id,
          execution_kind: "scheduled",
          status: "error",
          error: "budget exhausted — strategy auto-paused (re-plan to continue)",
        });
        continue;
      }
      insertDipTrade({
        watcher_id: strategy.watcher_id,
        strategy_id: strategy.id,
        execution_kind: "scheduled",
        status: "error",
        error: e.message,
      });
    }
  }
}

async function reconcile() {
  const watchers = getActiveDipWatchers();
  const activeIds = new Set(watchers.map((w) => w.id));

  for (const [id, entry] of active) {
    if (!activeIds.has(id)) {
      entry.unwatch();
      active.delete(id);
      console.log(`[dip-watcher] Stopped watching ${id}`);
    }
  }

  for (const w of watchers) {
    if (!active.has(w.id)) {
      try { await subscribe(w); }
      catch (e) { console.error(`[dip-watcher] Failed to subscribe ${label(w)}: ${e.message}`); }
    }
  }

  syncWatchdogs(watchers);
}

/**
 * One watchdog per chain with active watchers. The watchdog's rebuild closure
 * drops every active subscription for that chain and re-subscribes from
 * scratch (the same code path as a fresh reconcile for those watchers).
 */
function syncWatchdogs(watchers) {
  const chains = new Set(watchers.map((w) => w.chain || "ethereum"));
  for (const chainKey of chains) {
    if (!_watchdogsArmed.has(chainKey)) {
      _watchdogsArmed.add(chainKey);
      startWatchdog(chainKey, async () => {
        // Drop every subscription for this chain, then re-run the normal
        // subscribe flow for its watchers (subscribe() repopulates `active`).
        // WS-only — no signer invalidation needed.
        const chainWatchers = getActiveDipWatchers().filter((w) => (w.chain || "ethereum") === chainKey);
        for (const [id, entry] of active) {
          if ((entry.chainKey ?? "ethereum") === chainKey) {
            try { entry.unwatch(); } catch {}
            active.delete(id);
          }
        }
        for (const w of chainWatchers) {
          try { await subscribe(w); }
          catch (e) { console.error(`[ws-watchdog] rebuild: failed to resubscribe ${label(w)} — ${e.message}`); }
        }
      });
      console.log(`[dip-watcher] ws-watchdog armed for ${chainKey}`);
    }
  }
  for (const chainKey of [..._watchdogsArmed]) {
    if (!chains.has(chainKey)) {
      _watchdogsArmed.delete(chainKey);
      stopWatchdog(chainKey);
      console.log(`[dip-watcher] ws-watchdog disarmed for ${chainKey} (no active watchers)`);
    }
  }
}

const _watchdogsArmed = new Set();

/**
 * Low-gas check: once per position-refresh cycle, read the signer's ETH
 * balance per chain and alert when it drops below LOW_GAS_ETH (default 0.005).
 * Deduped by notify.mjs — it re-fires only after the dedupe window or when
 * forced. A wallet that can't pay gas is a silent stop for every strategy.
 */
async function checkGasBalance() {
  const threshold = Number(process.env.LOW_GAS_ETH ?? 0.005);
  const chains = new Set(getActiveDipWatchers().map((w) => w.chain || "ethereum"));
  for (const chainKey of chains) {
    try {
      const signer = await resolveSigner(chainKey); // system signer: gas float is the operator's concern
      const balanceEth = Number(await signer.getEthBalanceWei()) / 1e18;
      if (balanceEth < threshold) {
        await alert(`low-gas-${chainKey}-${signer.address}`,
          `⛽ LOW GAS on ${chainKey}: ${signer.address.slice(0, 8)}…${signer.address.slice(-6)} holds ${balanceEth.toFixed(5)} ETH (below ${threshold}) — trades will fail until refilled`,
          { force: true }); // forced: running-out-of-money is worth repeating
      }
    } catch (e) {
      console.error(`[dip-watcher] gas check failed on ${chainKey}: ${e.message}`);
    }
  }
}

/** Rescan the wallet's balance/USD value/cost basis for every active token. */
async function refreshPositions() {
  for (const w of getActiveDipWatchers()) {
    const chainKey = w.chain || "ethereum";
    try {
      // Balance READS sum the user's wallets (SCW + browser EOA) — launchpad
      // buys land in the EOA, app trades in the SCW; show the TOTAL. (2026-09-19)
      const { resolveUserReadWallets } = await import("./smart-wallet-api.mjs");
      const readWallets = await resolveUserReadWallets(w.user_id, chainKey);
      const pos = await computeWalletPosition({ contractAddress: w.contract_address, decimals: w.decimals ?? 18, walletAddresses: readWallets, chainKey });
      updateWalletPosition(w.id, {
        balance: pos.balance, balanceUsd: pos.balanceUsd, priceUsd: pos.priceUsd,
        costBasisUsd: pos.costBasisUsd, unrealizedPlUsd: pos.unrealizedPlUsd, unrealizedPlPct: pos.unrealizedPlPct,
        realizedPlUsd: pos.realizedPlUsd,
      });
    } catch (e) {
      console.error(`[dip-watcher] position refresh failed for ${label(w)}: ${e.message}`);
      updateWalletPosition(w.id, { error: e.message });
    }
  }
}

console.log("[dip-watcher] Starting — polling for active watchers every 30s");
// Signer gate: the smart account (AA session key) is a valid signer too. The
// old check only knew about AGENT_PRIVATE_KEY / VAULT_ACTIVE and crash-looped
// the VPS deployment (session-key-only .env). Any resolvable signer passes;
// a broken AA config throws on first resolveSigner and pm2 restarts anyway.
if (!process.env.AGENT_PRIVATE_KEY && process.env.VAULT_ACTIVE !== "true" && process.env.SMART_ACCOUNT_ACTIVE !== "true") {
  console.error("[dip-watcher] No signer configured. Set SMART_ACCOUNT_ACTIVE=true (with AA_SESSION_KEY), AGENT_PRIVATE_KEY, or VAULT_ACTIVE=true in .env");
  process.exit(1);
}

await reconcile();
setInterval(reconcile, RECONCILE_MS);
runScheduledBuys().catch((e) => console.error(`[dip-watcher] scheduled Zooch buy check failed: ${e.message}`));
setInterval(() => runScheduledBuys().catch((e) => console.error(`[dip-watcher] scheduled Zooch buy check failed: ${e.message}`)), RECONCILE_MS);

refreshPositions().catch((e) => console.error(`[dip-watcher] initial position refresh failed: ${e.message}`));
setInterval(() => refreshPositions().catch((e) => console.error(`[dip-watcher] position refresh failed: ${e.message}`)), POSITION_REFRESH_MS);

checkGasBalance().catch((e) => console.error(`[dip-watcher] initial gas check failed: ${e.message}`));
setInterval(() => checkGasBalance().catch((e) => console.error(`[dip-watcher] gas check failed: ${e.message}`)), POSITION_REFRESH_MS);
