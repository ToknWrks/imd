/**
 * dip-swap.mjs — Uniswap V3/V4 pool discovery, quoting, and ETH→token swap
 * execution, multi-chain (chains.mjs owns per-chain contract addresses and
 * RPC endpoints). Signer-agnostic: works with whatever signer.mjs's
 * resolveSigner() returns (raw key or VultiSig vault).
 */
import { createPublicClient, http, getAddress, parseAbi, keccak256, encodeAbiParameters, parseAbiParameters, encodeFunctionData, encodePacked, formatUnits } from "viem";
import { httpClient as chainHttpClient, getChain, getEthUsdPriceFor, getArchiveClient } from "./chains.mjs";
import { buyCurveCoin } from "./curve-buy.mjs";
import { recordGasForTx } from "./gas-ledger.mjs";
import { findLongVenue, executeLongBuy } from "./long-platform.mjs";

// ── Ethereum-mainnet constants (kept for backward compatibility — used by
// dashboard.mjs's ethereum-only wallet summary display) ──────────────────────

export const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const FEE_TIERS = [500, 3000, 10000];

// ── ABIs (minimal fragments) ──────────────────────────────────────────────────

const FACTORY_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const POOL_ABI = parseAbi([
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
/** Multi-hop quote (V3): packed path + exactAmountIn. */
const QUOTER_PATH_ABI = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
export const ROUTER_ABI = parseAbi([
  // SwapRouter02's ExactInputSingleParams has NO deadline field (deadline
  // enforcement lives in the multicall(uint256,bytes[]) overload). Encoding
  // the 8-field QuoterV2 struct here shifts every later arg by one slot and
  // reverts instantly — verified via debug_traceCall on Base 2026-09-09.
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
  "function wrapETH(uint256 value) payable",
  "function refundETH() payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);
const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
export const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// ── RPC clients (multi-chain; chains.mjs owns endpoints) ─────────────────────

function httpRpcUrl(chainKey = "ethereum") {
  return getChain(chainKey).httpRpc();
}

/** WebSocket RPC URL for real-time event subscriptions on a chain. */
export function wsRpcUrl(chainKey = "ethereum") {
  return getChain(chainKey).wsRpc();
}

let _client = null;
let _clientChain = null;
function client(chainKey = "ethereum") {
  if (_client && _clientChain === chainKey) return _client;
  // Batching matters for wallet-position.mjs, which can issue many historical
  // eth_calls/getTransaction lookups — this combines bursts of them into a
  // handful of HTTP requests instead of one round-trip each.
  _client = chainHttpClient(chainKey);
  _clientChain = chainKey;
  return _client;
}

/** Shared read client for read-only analysis modules. */
export function getPublicClient(chainKey = "ethereum") {
  return client(chainKey);
}

let _analysisClient = null;
let _analysisChain = null;
/** Zooch historical scans use an unbatched client. Its caller serializes
 * requests so a high-volume review cannot turn provider retries into a batch. */
export function getAnalysisClient(chainKey = "ethereum") {
  if (_analysisClient && _analysisChain === chainKey) return _analysisClient;
  _analysisClient = createPublicClient({
    chain: getChain(chainKey).viemChain,
    transport: http(httpRpcUrl(chainKey), { batch: false, retryCount: 0 }),
  });
  _analysisChain = chainKey;
  return _analysisClient;
}

// ── Pool discovery ────────────────────────────────────────────────────────────

const V2_FACTORY_ABI = parseAbi(["function getPair(address,address) view returns (address)"]);

const POOL_MANAGER_ABI = parseAbi(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"]);
const V4_QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const V4_ROUTER_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable returns ()",
  "function unlockWithData(bytes data) payable returns ()",
]);
const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint16 protocolFee, uint16 lpFee)",
]);
const V4_INITIALIZE_ABI = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
const V2_PAIR_ABI = parseAbi([
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function token0() view returns (address)",
]);

// ── Uniswap V4 support ────────────────────────────────────────────────────────

/** ABI-encode a V4 poolKey (currency0, currency1, fee, tickSpacing, hooks). */
function encodePoolKey(poolKey) {
  return encodeAbiParameters(
    parseAbiParameters("address, address, uint24, int24, address"),
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
  );
}

/** Derive the V4 poolId (keccak256 of the abi-encoded poolKey). */
export function derivePoolId(poolKey) {
  return keccak256(encodePoolKey(poolKey));
}

const ETH_ADDRESS = "0x0000000000000000000000000000000000000000";

// Standard Uniswap fee/tickSpacing pairs, plus non-standard combos verified
// live on Robinhood Chain (scripts/scan-robinhood-genesis.mjs — many USDG V4
// pools there don't use the standard tiers). Hooks assumed zero throughout; a
// hooked pool needs its hook address read from the pool's Initialize event.
const STANDARD_FEE_TICKS = [[100, 1], [500, 10], [3000, 60], [10000, 200]];
const VERIFIED_NONSTANDARD_FEE_TICKS = [[2980, 60], [4900, 98], [30000, 600], [50000, 500]]; // 50000/500: real Base ETH/LAPTOP pool 0x0bcf…

/**
 * Recover a V4 poolKey directly from its Initialize event — exact, not
 * guessed. Required for hooked pools or non-standard fee/tickSpacing (verified
 * live on Robinhood: a real pool has fee=0 and a non-zero hooks address, which
 * no brute-force candidate search can find). Falls back to null (caller tries
 * brute force) if the log can't be found, e.g. an RPC that caps getLogs range.
 */
// Persistent poolKey cache: derived poolKeys are immutable (a poolId IS the
// keccak of its poolKey), so once recovered they never need re-deriving.
// Survives RPC outages (the 2026-09-11 incident: Cloudflare-gated public RPC
// made every Initialize lookup fail, auto-pausing all MM strategies and
// blinding the dip-watcher for already-known pools).
import { readFileSync as _readPk, writeFileSync as _writePk } from "fs";
import { resolve as _resolve, dirname as _dirname } from "path";
import { fileURLToPath as _fileURLToPath } from "url";
const _PK_CACHE_PATH = _resolve(_dirname(_fileURLToPath(import.meta.url)), "data/v4-poolkey-cache.json");
const _pkCache = (() => { try { return JSON.parse(_readPk(_PK_CACHE_PATH, "utf8")); } catch { return {}; } })();
function cachePoolKey(chainKey, poolId, poolKey) {
  try {
    _pkCache[`${chainKey}:${poolId.toLowerCase()}`] = poolKey;
    _writePk(_PK_CACHE_PATH, JSON.stringify(_pkCache, null, 1));
  } catch {}
}
function cachedPoolKey(chainKey, poolId) {
  return _pkCache[`${chainKey}:${poolId.toLowerCase()}`] ?? null;
}

async function lookupV4PoolKeyFromInitialize(poolId, chainKey) {
  const dep = getChain(chainKey);
  // 1) persistent cache — zero RPC calls for known pools
  const hit = cachedPoolKey(chainKey, poolId);
  if (hit) return hit;
  try {
    // Full-range getLogs needs a logs-capable endpoint: Alchemy free tier caps
    // getLogs at 10 blocks (Robinhood), so use the chain's dedicated
    // getLogsRpc() when one is defined, else the normal client.
    const logsClient = dep.getLogsRpc
      ? createPublicClient({ chain: dep.viemChain, transport: http(dep.getLogsRpc(), { retryCount: 1 }) })
      : client(chainKey);
    const logs = await logsClient.getLogs({
      address: dep.v4.poolManager, event: V4_INITIALIZE_ABI[0], args: { id: poolId }, fromBlock: 0n, toBlock: "latest",
    });
    if (!logs.length) return null;
    const { currency0, currency1, fee, tickSpacing, hooks } = logs[0].args;
    const key = { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks };
    cachePoolKey(chainKey, poolId, key);
    return key;
  } catch { /* fall through to Blockscout */ }

  // Full-range getLogs is blocked on many RPCs (Alchemy free tier: 10-block
  // cap). Blockscout's API has no range cap — verified live recovering the
  // poolKey for a real Base V4 pool (ETH/LAPTOP fee 50000 / ts 500).
  try {
    const explorerByChain = {
      // Etherscan v2 now requires an API key (verified 2026-09-14: keyless calls
      // return "Missing/Invalid API Key") — mainnet uses Blockscout instead.
      ethereum: "https://eth.blockscout.com",
      base: "https://base.blockscout.com",
      // Robinhood's Blockscout has no getLogs range cap (verified live
      // 2026-09-10 recovering ATLANTIS's hooked poolKey: fee 8388608 / ts 8).
      robinhood: "https://robinhoodchain.blockscout.com",
    };
    const base_ = explorerByChain[chainKey];
    if (!base_) return null;
    const url = `${base_}/api?module=logs&action=getLogs`
      + `&address=${dep.v4.poolManager}`
      + `&topic0=0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438`
      + `&topic0_1_opr=and&topic1=${poolId.toLowerCase()}`
      + `&fromBlock=0&toBlock=latest`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const j = await res.json();
    const log = (j.result ?? [])[0];
    if (!log || !log.data || log.data.length < 2 + 64 * 5) return null;
    const words = log.data.slice(2).match(/.{64}/g) ?? [];
    const w = (i) => BigInt("0x" + words[i]);
    const topics = log.topics ?? [];
    const addrFromWord = (x) => "0x" + x.slice(-40);
    const currency0 = topics[2] ? "0x" + topics[2].slice(-40) : addrFromWord(words[2]);
    const currency1 = topics[3] ? "0x" + topics[3].slice(-40) : addrFromWord(words[3]);
    const key = {
      currency0,
      currency1,
      fee: Number(w(0)),
      tickSpacing: Number(w(1)),
      hooks: addrFromWord(words[2]),
    };
    cachePoolKey(chainKey, poolId, key);
    return key;
  } catch {
    return null;
  }
}

/**
 * Build the Universal Router's SWAP_EXACT_IN (path-based) action payload for
 * a single-hop native-ETH -> token swap. Hand-built via raw word encoding
 * rather than encodeAbiParameters because IV4Router's ExactInputParams has an
 * extra trailing empty dynamic field beyond {currencyIn, path, amountIn,
 * amountOutMinimum} that isn't in any published ABI fragment — verified by
 * decoding Uniswap's own frontend calldata for a hooked pool on Robinhood
 * Chain, then confirmed generalizable via eth_estimateGas with different
 * amounts. Required for hooked pools: SWAP_EXACT_IN_SINGLE (the simpler,
 * normally-used action) reverts on at least one real Pons-launcher hook.
 */
function buildV4ExactInPathPayload({ currencyIn = ETH_ADDRESS, token, fee, tickSpacing, hooks, amountIn, amountOutMinimum }) {
  const wn = (n) => BigInt(n).toString(16).padStart(64, "0");
  const addr = (a) => a.slice(2).toLowerCase().padStart(64, "0");
  const HEAD_WORDS = 5; // currencyIn, path offset, trailing-empty-field offset, amountIn, amountOutMinimum
  const PATH_WORDS = 8; // length(1) + elementOffset + currency + fee + tickSpacing + hooks + hookDataOffset + hookDataLength(0)
  const pathOffset = HEAD_WORDS * 32;
  const emptyFieldOffset = pathOffset + PATH_WORDS * 32;
  const tuple = [
    addr(currencyIn), wn(pathOffset), wn(emptyFieldOffset), wn(amountIn), wn(amountOutMinimum),
    wn(1), wn(0x20), addr(token), wn(fee), wn(tickSpacing), addr(hooks), wn(0xa0), wn(0), wn(0),
  ];
  return "0x" + wn(0x20) + tuple.join("");
}

/** Every (fee, tickSpacing) x (ETH-first, ETH-second) poolKey candidate for a token. */
function v4PoolKeyCandidates(token) {
  const candidates = [];
  for (const [fee, tickSpacing] of [...STANDARD_FEE_TICKS, ...VERIFIED_NONSTANDARD_FEE_TICKS]) {
    for (const [currency0, currency1] of [[ETH_ADDRESS, token], [token, ETH_ADDRESS]]) {
      candidates.push({ currency0, currency1, fee, tickSpacing, hooks: ETH_ADDRESS });
    }
  }
  return candidates;
}

/**
 * Validate a user-supplied pool override and resolve it to a full venue
 * descriptor. Accepts:
 *   - a Uniswap V3 pool contract address (40-hex, not the token itself)
 *   - a Uniswap V4 poolId (64-hex / 66-char 0x-hex)
 *   - "auto" / empty / null → no override (auto-discovery)
 * Throws with a human-readable error when the value looks like an override but
 * can't be resolved — callers should surface that to the user.
 * @returns {Promise<null | { kind: "v3", address, token0, token1, fee } | { kind: "v4", poolId, poolKey, fee, tickSpacing, hooks, currency0, currency1, liquidityUsd: 0 }>}
 */
export async function resolvePoolOverride(tokenAddress, override, chainKey = "ethereum") {
  const value = (override ?? "").trim();
  if (!value || value.toLowerCase() === "auto") return null;
  if (!/^0x[0-9a-fA-F]{40,64}$/.test(value)) {
    throw new Error(`invalid pool address "${value}" — expected a V3 pool contract or V4 poolId (0x + 40 or 64 hex chars), or "auto"`);
  }

  const token = getAddress(tokenAddress);
  const dep = getChain(chainKey);

  // V4 poolId (66 chars with 0x) — verify via StateView and recover the poolKey
  if (value.length === 66) {
    const poolId = value.toLowerCase();
    try {
      await client(chainKey).readContract({ address: dep.v4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] });
    } catch {
      throw new Error(`poolId ${poolId.slice(0, 12)}… not found on ${dep.name}'s Uniswap V4 PoolManager — check the value`);
    }
    const exact = await lookupV4PoolKeyFromInitialize(poolId, chainKey);
    if (exact) return { kind: "v4", poolId, poolKey: exact, fee: exact.fee, tickSpacing: exact.tickSpacing, hooks: exact.hooks, currency0: exact.currency0, currency1: exact.currency1, liquidityUsd: 0 };
    for (const poolKey of v4PoolKeyCandidates(token)) {
      if (derivePoolId(poolKey) === poolId) {
        return { kind: "v4", poolId, poolKey, fee: poolKey.fee, tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks, currency0: poolKey.currency0, currency1: poolKey.currency1, liquidityUsd: 0 };
      }
    }
    throw new Error(`poolId ${poolId.slice(0, 12)}… exists but its poolKey couldn't be derived (hooked pool or non-standard fee/tickSpacing)`);
  }

  // V3 pool contract (40-hex) — verify it's a real pool containing the token
  const c = client(chainKey);
  let token0, token1, fee;
  try {
    [token0, token1, fee] = await Promise.all([
      c.readContract({ address: value, abi: POOL_ABI, functionName: "token0" }),
      c.readContract({ address: value, abi: POOL_ABI, functionName: "token1" }),
      c.readContract({ address: value, abi: POOL_ABI, functionName: "fee" }),
    ]);
  } catch {
    throw new Error(`address ${value} doesn't look like a Uniswap V3 pool (no token0/token1/fee)`);
  }
  if (![token0, token1].some((a) => a.toLowerCase() === token.toLowerCase())) {
    throw new Error(`pool ${value} doesn't contain token ${token}`);
  }
  return { kind: "v3", address: getAddress(value), token0, token1, fee: Number(fee) };
}

/**
 * Query Dexscreener for every Uniswap venue a token trades on, then return the
 * highest-liquidity Uniswap V4 pool (label "v4"), verified on-chain via
 * StateView.getSlot0 so we never act on a stale/unregistered poolId.
 * @returns {Promise<null | { kind: "v4", poolId: string, poolKey: object, liquidityUsd: number, fee: number, tickSpacing: number, hooks: string, currency0: string, currency1: string }>}
 */
// IMD launchpad indexer (curve coin registry) + the canonical ETH/IMD pool.
const IMD_INDEXER_URL = process.env.IMD_INDEXER_URL || "https://imd-communitycoins-indexer.up.railway.app/graphql";
const IMD_ETH_POOL_ID = "0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3";

export async function findBestV4Pool(tokenAddress, chainKey = "ethereum") {
  const token = getAddress(tokenAddress).toLowerCase();
  const dep = getChain(chainKey);
  let pairs;
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/${dep.dexscreener}/${token}`);
    pairs = await res.json();
  } catch {
    return null; // Dexscreener down — caller falls back to V3
  }
  const v4 = (pairs ?? [])
    .filter((p) => p.dexId === "uniswap" && (p.labels ?? []).includes("v4"))
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  if (!v4.length) return null;

  for (const p of v4) {
    const poolId = p.pairAddress?.toLowerCase();
    if (!poolId || poolId.length !== 66) continue;
    // Verify the pool exists on-chain before trusting it
    try {
      await client(chainKey).readContract({ address: dep.v4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] });
    } catch {
      continue;
    }
    // Recover the poolKey: look up the exact Initialize event first (handles
    // hooked pools and non-standard fee/tickSpacing), else brute-force known
    // fee/tickSpacing pairs assuming zero hooks and native ETH (address 0).
    const exact = await lookupV4PoolKeyFromInitialize(poolId, chainKey);
    if (exact) return { kind: "v4", poolId, poolKey: exact, liquidityUsd: p.liquidity?.usd ?? 0, fee: exact.fee, tickSpacing: exact.tickSpacing, hooks: exact.hooks, currency0: exact.currency0, currency1: exact.currency1 };
    for (const poolKey of v4PoolKeyCandidates(token)) {
      if (derivePoolId(poolKey) === poolId) {
        return { kind: "v4", poolId, poolKey, liquidityUsd: p.liquidity?.usd ?? 0, fee: poolKey.fee, tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks, currency0: poolKey.currency0, currency1: poolKey.currency1 };
      }
    }
  }
  return null;
}

/**
 * Find the best Uniswap V2 WETH pair for a token (used as a fallback venue).
 * @returns {Promise<null | { kind: "v2", address: string }>}
 */
export async function findBestV2Pair(tokenAddress, chainKey = "ethereum") {
  const token = getAddress(tokenAddress);
  const dep = getChain(chainKey);
  const c = client(chainKey);
  try {
    const pair = await c.readContract({ address: dep.v3.v2Factory, abi: V2_FACTORY_ABI, functionName: "getPair", args: [token, dep.weth] });
    if (!pair || pair === "0x0000000000000000000000000000000000000000") return null;
    return { kind: "v2", address: pair };
  } catch {
    return null;
  }
}

// ── Aerodrome (Base) ─────────────────────────────────────────────────────────

const AERO_POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint256, uint256, uint256)",
  "function stable() view returns (bool)",
]);
const AERO_CL_POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 protocolFee, uint16 lpFee)",
  "function liquidity() view returns (uint128)",
]);

/** USD liquidity of an Aerodrome pool — V2 reserves or CL in-range estimate. */
async function measureAeroLiquidityUsd(pool, tokenIs0, quote, chainKey) {
  const c = client(chainKey);
  if (pool.kind === "aero-cl" || clMetaHas(pool)) {
    const [s0, liq] = await Promise.all([
      c.readContract({ address: pool.address, abi: AERO_CL_POOL_ABI, functionName: "slot0" }),
      c.readContract({ address: pool.address, abi: AERO_CL_POOL_ABI, functionName: "liquidity" }),
    ]);
    const sqrtP = Number(s0[0]) / 2 ** 96;
    // Rough ranking-only conversion: single-sided value ≈ L·√P; denominate in
    // quote via spot. Never used for swap math or sell sizing.
    const quoteUnits = tokenIs0
      ? Math.sqrt(Number(liq) / (sqrtP * sqrtP))
      : Math.sqrt(Number(liq) * (sqrtP * sqrtP));
    return pool.quote === "usdc" ? (quoteUnits / 1e6) * 2 : (quoteUnits / 1e18) * 2 * await getEthUsdPrice(chainKey);
  }
  const reserves = await c.readContract({ address: pool.address, abi: AERO_POOL_ABI, functionName: "getReserves" });
  const quoteAmount = Number(tokenIs0 ? reserves[1] : reserves[0]);
  return quote === "usdc" ? (quoteAmount / 1e6) * 2 : (quoteAmount / 1e18) * 2 * await getEthUsdPrice(chainKey);
}

function clMetaHas(pool) { return Boolean(pool?.fee != null || pool?.tickSpacing != null); }

/**
 * Find the token's best Aerodrome pool on Base, measured by quote-side USD
 * liquidity. Covers both Aerodrome flavors:
 *   - V2-style (poolFactory, stable/volatile pairs) — quote = WETH
 *   - Slipstream CL (slipstreamFactory, fee/tickSpacing tiers) — quote is
 *     usually native USDC, occasionally WETH
 * @returns {Promise<null | { kind: "aero-v2" | "aero-cl", address: string, quote: "usdc" | "weth", liquidityUsd: number, token0IsQuote: boolean, stable: boolean, fee?: number, tickSpacing?: number }>}
 */
export async function findBestAerodromePool(tokenAddress, chainKey = "base") {
  const dep = getChain(chainKey);
  const aero = dep.aerodrome;
  if (!aero) return null;
  const token = getAddress(tokenAddress);
  const c = client(chainKey);

  // 1) On-chain V2 pools from the Aerodrome poolFactory (stable + volatile,
  //    WETH- and USDC-quoted). The factory ABI here is verified live.
  const candidates = [];
  const v2Abi = parseAbi(["function getPool(address, address, bool) view returns (address)"]);
  const ZERO = "0x0000000000000000000000000000000000000000";
  for (const stable of [false, true]) {
    candidates.push(
      c.readContract({ address: aero.poolFactory, abi: v2Abi, functionName: "getPool", args: [token, dep.weth, stable] }).then((p) => p === ZERO ? null : { kind: "aero-v2", address: p, stable, quote: "weth" }).catch(() => null),
      c.readContract({ address: aero.poolFactory, abi: v2Abi, functionName: "getPool", args: [token, dep.dollar, stable] }).then((p) => p === ZERO ? null : { kind: "aero-v2", address: p, stable, quote: "usdc" }).catch(() => null),
    );
  }

  // 2) Slipstream (CL) pools: the factory's pool lookup reverted on every
  //    probed signature, so discover via Dexscreener instead — it lists
  //    aerodrome pairs with their pool address; we classify each on-chain by
  //    probing the CL shape (fee/tickSpacing/slot0). Verified against
  //    LAPTOP's $1.6M USDC/LAPTOP CL pool (fee 20000, ts 200).
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/${dep.dexscreener}/${token}`);
    if (res.ok) {
      const pairs = await res.json();
      for (const p of (Array.isArray(pairs) ? pairs : [])) {
        if (p.dexId !== "aerodrome" || !p.pairAddress) continue;
        candidates.push(Promise.resolve({ kind: "aero-cl?", address: p.pairAddress, quote: null, dexLiquidityUsd: p.liquidity?.usd ?? 0 }));
      }
    }
  } catch { /* Dexscreener down — V2 factory results still usable */ }

  const found = (await Promise.all(candidates)).filter(Boolean);
  if (!found.length) return null;

  // Measure USD liquidity: quote-side reserves (V2) or in-range liquidity
  // converted at spot (CL). Dedupe (a pool can match multiple candidates).
  const seen = new Map();
  for (const pool of found) {
    if (seen.has(pool.address.toLowerCase())) continue;
    seen.set(pool.address.toLowerCase(), pool);
  }
  const measured = await Promise.all([...seen.values()].map(async (pool) => {
    try {
      // Classify on-chain: CL pools expose fee()/tickSpacing(), V2 pools
      // expose getReserves(). Then denominate the quote asset.
      let t0, t1, clMeta = null;
      try {
        const [fee, tickSpacing] = await Promise.all([
          c.readContract({ address: pool.address, abi: AERO_CL_POOL_ABI, functionName: "fee" }),
          c.readContract({ address: pool.address, abi: AERO_CL_POOL_ABI, functionName: "tickSpacing" }),
        ]);
        clMeta = { fee: Number(fee), tickSpacing: Number(tickSpacing) };
      } catch { /* V2 pool — no fee()/tickSpacing() */ }
      const pairAbi = clMeta ? AERO_CL_POOL_ABI : AERO_POOL_ABI;
      [t0, t1] = await Promise.all([
        c.readContract({ address: pool.address, abi: pairAbi, functionName: "token0" }),
        c.readContract({ address: pool.address, abi: pairAbi, functionName: "token1" }),
      ]);
      const tokenIs0 = t0.toLowerCase() === token.toLowerCase();
      const quoteAddr = (tokenIs0 ? t1 : t0).toLowerCase();
      const quote = quoteAddr === dep.dollar.toLowerCase() ? "usdc" : quoteAddr === dep.weth.toLowerCase() ? "weth" : null;
      if (!quote) return null; // unknown quote — can't denominate the sell
      const liquidityUsd = pool.dexLiquidityUsd > 0
        ? pool.dexLiquidityUsd
        : await measureAeroLiquidityUsd(pool, tokenIs0, quote, chainKey);
      return { ...pool, kind: clMeta ? "aero-cl" : "aero-v2", ...clMeta, quote, token0IsQuote: !tokenIs0, liquidityUsd };
    } catch {
      return null;
    }
  }));
  const valid = measured.filter((p) => p && p.liquidityUsd > 0);
  if (!valid.length) return null;
  return valid.sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
}

/**
 * Find the highest-liquidity WETH pool for a token across the standard
 * Uniswap V3 fee tiers (0.05% / 0.3% / 1%).
 * @returns {Promise<{ fee: number, address: string, liquidity: bigint, token0: string, token1: string }>}
 */
export async function findBestPool(tokenAddress, chainKey = "ethereum") {
  const token = getAddress(tokenAddress);
  const dep = getChain(chainKey);
  if (dep.v3.factory === ETH_ADDRESS) {
    throw new Error(`Uniswap V3 is not available on ${dep.name} — no factory address configured`);
  }
  const c = client(chainKey);

  const candidates = await Promise.all(FEE_TIERS.map(async (fee) => {
    const pool = await c.readContract({ address: dep.v3.factory, abi: FACTORY_ABI, functionName: "getPool", args: [token, dep.weth, fee] });
    if (!pool || pool === "0x0000000000000000000000000000000000000000") return null;
    const [liquidity, token0, token1] = await Promise.all([
      c.readContract({ address: pool, abi: POOL_ABI, functionName: "liquidity" }),
      c.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }),
      c.readContract({ address: pool, abi: POOL_ABI, functionName: "token1" }),
    ]);
    return { fee, address: pool, liquidity, token0, token1 };
  }));

  const valid = candidates.filter(Boolean);
  if (!valid.length) throw new Error(`No WETH pool found for ${token} on Uniswap V3 (fee tiers ${FEE_TIERS.join("/")})`);
  valid.sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0));
  return valid[0];
}

/** ERC-20 decimals + symbol, best-effort, memoized per (chain, token) —
 *  decimals/symbol are immutable, but the MM daemon was re-reading them
 *  every poll (2 Alchemy calls × strategy × poll — 2026-09-11 rate-limit). */
const _tokenMetaCache = new Map();
export async function getTokenMeta(tokenAddress, chainKey = "ethereum") {
  const token = getAddress(tokenAddress);
  const cacheKey = `${chainKey}:${token.toLowerCase()}`;
  const hit = _tokenMetaCache.get(cacheKey);
  if (hit) return hit;
  const c = client(chainKey);
  const [decimals, symbol] = await Promise.all([
    c.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
    c.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => null),
  ]);
  const meta = { decimals, symbol };
  _tokenMetaCache.set(cacheKey, meta);
  return meta;
}

/** Live ETH/USD price for a chain (Chainlink feed, or the ETH/dollar V4 pool
 *  where there's no feed — see chains.mjs's getEthUsdPriceFor). */
export async function getEthUsdPrice(chainKey = "ethereum") {
  return getEthUsdPriceFor(chainKey);
}

/** ERC-20 balanceOf, raw (smallest-unit) bigint. */
export async function getErc20Balance(tokenAddress, walletAddress, chainKey = "ethereum") {
  const c = client(chainKey);
  return c.readContract({
    address: getAddress(tokenAddress), abi: ERC20_ABI, functionName: "balanceOf", args: [getAddress(walletAddress)],
  });
}

/** Native ETH balance, raw (wei) bigint. */
export async function getEthBalance(walletAddress, chainKey = "ethereum") {
  const c = client(chainKey);
  return c.getBalance({ address: getAddress(walletAddress) });
}

/** ETH value (native, in whole ETH) attached to a transaction — how much ETH the
 *  wallet actually sent as part of that specific swap/transfer. */
/** Native ETH value attached to a tx (msg.value). For EXIT proceeds this is the
 *  wrong signal on V4: flash routing delivers ETH via TAKE (internal transfer),
 *  not msg.value — a real sell shows value=0 while the wallet's ETH balance
 *  rises. Callers needing DELIVERED ETH must use getTxDeliveredEth instead. */
export async function getTxEthValue(txHash, chainKey = "ethereum") {
  const c = client(chainKey);
  const tx = await c.getTransaction({ hash: txHash });
  return Number(tx.value) / 1e18;
}

/** Native ETH actually DELIVERED to `wallet` by a tx: balance(block) −
 *  balance(block−1) + gas refund. Catches V4 TAKE-path proceeds that never
 *  appear as msg.value or an ERC-20 transfer (HASH exits paid 0.02 ETH with
 *  msg.value=0 — realized P/L silently excluded every such sell). */
export async function getTxDeliveredEth(txHash, wallet, chainKey = "ethereum") {
  const c = client(chainKey);
  const rec = await c.getTransactionReceipt({ hash: txHash });
  if (!rec || rec.status !== "success") return 0;
  const [after, before] = await Promise.all([
    c.getBalance({ address: wallet, blockNumber: rec.blockNumber }),
    c.getBalance({ address: wallet, blockNumber: rec.blockNumber - 1n }),
  ]);
  const gas = rec.gasUsed * (rec.effectiveGasPrice ?? 0n);
  // The wallet PAID gas out of the same balance: proceeds = delta + gas spent.
  return Number(after - before + gas) / 1e18;
}

async function getSlot0(poolAddress, blockNumber, chainKey = "ethereum") {
  const c = client(chainKey);
  const slot0 = await c.readContract({
    address: poolAddress, abi: POOL_ABI, functionName: "slot0",
    ...(blockNumber != null ? { blockNumber: BigInt(blockNumber) } : {}),
  });
  return slot0[0]; // sqrtPriceX96
}

/** (sqrtPriceX96/2^96)^2 — the pool's raw token1-per-token0 ratio (smallest units). */
function sqrtPriceToRawRatio(sqrtPriceX96) {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  return s * s;
}

/**
 * Spot price (ETH per 1 whole token) from a pool's slot0, optionally at a
 * historical block. Cheaper and simpler than the Quoter — fine for pricing,
 * not for simulating swap slippage.
 */
export async function getTokenSpotPriceEth({ poolAddress, wethIsToken0, tokenDecimals }, blockNumber, chainKey = "ethereum") {
  const sqrtPriceX96 = await getSlot0(poolAddress, blockNumber, chainKey);
  const rawRatio = sqrtPriceToRawRatio(sqrtPriceX96); // token1 per token0, raw units
  const d0 = wethIsToken0 ? 18 : tokenDecimals;
  const d1 = wethIsToken0 ? tokenDecimals : 18;
  const humanRatio = rawRatio * 10 ** (d0 - d1); // token1 whole units per 1 token0 whole unit
  return wethIsToken0 ? 1 / humanRatio : humanRatio; // ETH per 1 TOKEN
}

const _usdcWethPools = new Map(); // chainKey → { address, usdcIsToken0 }
async function usdcWethPool(chainKey = "ethereum") {
  if (_usdcWethPools.has(chainKey)) return _usdcWethPools.get(chainKey);
  const dep = getChain(chainKey);
  const c = client(chainKey);
  const address = await c.readContract({ address: dep.v3.factory, abi: FACTORY_ABI, functionName: "getPool", args: [dep.dollar, dep.weth, 500] });
  const token0 = await c.readContract({ address, abi: POOL_ABI, functionName: "token0" });
  const pool = { address, usdcIsToken0: token0.toLowerCase() === dep.dollar.toLowerCase() };
  _usdcWethPools.set(chainKey, pool);
  return pool;
}

/**
 * ETH/USD price reconstructed on-chain at a historical block (no third-party
 * price-history API required). Used for cost-basis reconstruction; live
 * buy/sell logic uses getEthUsdPrice()/getEthUsdPriceFor() instead. Chains
 * with no V3 dollar/WETH pool (Robinhood) fall back to the chain's V4
 * ETH/dollar pool's slot0 at that same block.
 */
export async function getEthUsdPriceAtBlock(blockNumber, chainKey = "ethereum") {
  const dep = getChain(chainKey);
  if (dep.v3.factory === ETH_ADDRESS) {
    const [sqrtPriceX96] = await getArchiveClient(chainKey).readContract({
      address: dep.v4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0",
      args: [dep.ethPricePoolId], blockNumber: BigInt(blockNumber),
    });
    const s = Number(sqrtPriceX96) / 2 ** 96;
    return s * s * 10 ** (18 - dep.dollarDecimals); // dollar units per 1 ETH
  }
  const { address, usdcIsToken0 } = await usdcWethPool(chainKey);
  const sqrtPriceX96 = await getSlot0(address, blockNumber, chainKey);
  const rawRatio = sqrtPriceToRawRatio(sqrtPriceX96);
  const d0 = usdcIsToken0 ? dep.dollarDecimals : 18;
  const d1 = usdcIsToken0 ? 18 : dep.dollarDecimals;
  const humanRatio = rawRatio * 10 ** (d0 - d1);
  return usdcIsToken0 ? 1 / humanRatio : humanRatio; // USD per 1 ETH
}

/** Quote WETH→token amountOut for a given ETH input (wei), via QuoterV2. */
export async function quoteBuy(tokenAddress, fee, amountInWei, chainKey = "ethereum") {
  const token = getAddress(tokenAddress);
  const dep = getChain(chainKey);
  const { result } = await client(chainKey).simulateContract({
    address: dep.v3.quoterV2, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
    args: [{ tokenIn: dep.weth, tokenOut: token, amountIn: amountInWei, fee, sqrtPriceLimitX96: 0n }],
  });
  return result[0]; // amountOut
}

/** Quote a token→WETH sell: returns WETH out (wei) for a given token in (raw). */
export async function quoteSellV3(tokenAddress, fee, tokenAmountRaw, chainKey = "ethereum") {
  const token = getAddress(tokenAddress);
  const dep = getChain(chainKey);
  const { result } = await client(chainKey).simulateContract({
    address: dep.v3.quoterV2, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
    args: [{ tokenIn: token, tokenOut: dep.weth, amountIn: tokenAmountRaw, fee, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

/** Quote a token→ETH sell through a V4 pool (zeroForOne=false: currency1→currency0). */
export async function quoteSellV4(pool, tokenAmountRaw, chainKey = "ethereum") {
  const { poolKey } = pool;
  const dep = getChain(chainKey);
  const { result } = await client(chainKey).simulateContract({
    address: dep.v4.quoter, abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle",
    args: [{
      poolKey: {
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks,
      },
      zeroForOne: false,
      exactAmount: tokenAmountRaw,
      hookData: "0x",
    }],
  });
  return result[0];
}

/** Spot ETH-per-token price from a V4 pool's slot0 (currency0 = native ETH). */
export async function getV4SpotPriceEth(pool, tokenDecimals = 18, chainKey = "ethereum") {
  const dep = getChain(chainKey);
  const [sqrtPriceX96] = await client(chainKey).readContract({
    address: dep.v4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [pool.poolId],
  });
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const tokenPerEth = s * s * 10 ** (18 - tokenDecimals); // currency1 whole units per 1 ETH
  return tokenPerEth > 0 ? 1 / tokenPerEth : 0;
}

/**
 * Token price in USD straight from a V4 pool whose quote asset is the chain's
 * dollar token (e.g. SIRIUS/USDG on Robinhood — pools with no ETH side, where
 * getV4SpotPriceEth is meaningless). sqrtPriceX96 = sqrt(raw1/raw0)·2^96, so
 * the whole-unit price depends on which side the token sits on:
 *   token = currency0 → usdPerToken = s² · 10^(tokenDecimals − dollarDecimals)
 *   token = currency1 → usdPerToken = 10^(dollarDecimals − tokenDecimals) / s²
 */
export async function getV4SpotPriceUsd(pool, tokenAddress, tokenDecimals = 18, chainKey = "ethereum") {
  const dep = getChain(chainKey);
  const [sqrtPriceX96] = await client(chainKey).readContract({
    address: dep.v4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [pool.poolId],
  });
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const tokenIsCurrency0 = getAddress(pool.poolKey.currency0).toLowerCase() === getAddress(tokenAddress).toLowerCase();
  let priceUsd;
  if (tokenIsCurrency0) {
    priceUsd = s * s * 10 ** (tokenDecimals - dep.dollarDecimals);
  } else {
    priceUsd = s > 0 ? 10 ** (dep.dollarDecimals - tokenDecimals) / (s * s) : 0;
  }
  return priceUsd > 0 && Number.isFinite(priceUsd) ? priceUsd : 0;
}

// ── V4 quoting & execution ────────────────────────────────────────────────────

/**
 * Quote an exact-in ETH→token swap through a V4 pool via the V4 Quoter lens.
 * `pool` is the object returned by findBestV4Pool(). Returns the amountOut.
 */
export async function quoteBuyV4(pool, amountInWei, chainKey = "ethereum") {
  const { poolKey } = pool;
  const dep = getChain(chainKey);
  // Buy direction: the input currency is currency0 in every pool we buy
  // through (native ETH, WETH for wrap-required pools, or the chain dollar).
  // currency0 === ETH alone is NOT the test — WETH-quoted pools (OPAI etc.)
  // have currency0 = WETH and were quoted BACKWARDS (OPAI→WETH), returning
  // dust that silently disabled the buy's slippage guard (live: quote said
  // 3.1e-10 tokens; the real swap delivered ~66K). Direction: selling
  // currency0 to receive currency1 → zeroForOne = true, always, here.
  const zeroForOne = true;
  const { result } = await client(chainKey).simulateContract({
    address: dep.v4.quoter, abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle",
    args: [{
      poolKey: {
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks,
      },
      zeroForOne,
      exactAmount: amountInWei,
      hookData: "0x",
    }],
  });
  return result[0]; // amountOut
}

/**
 * Build + execute a V4 buy paying with the chain's dollar token (e.g. USDG on
 * Robinhood) through a token/dollar pool. Used when the resolved venue's
 * currencies are {token, dollar} and the wallet funds the buy in the dollar —
 * the pool has no ETH side, so an ETH buy is impossible without an extra hop.
 *
 * Flow (single execute(), atomic):
 *   SWAP_EXACT_IN(0x07) dollar → token through the pool,
 *   SETTLE(0x0b) payerIsUser=true (router pulls the dollar from the wallet
 *   through Permit2 — the wallet must have approved Permit2, see below),
 *   TAKE(0x0e) token → recipient.
 * Permit2 chain (only when allowance is missing/insufficient):
 *   1. dollar.approve(PERMIT2, max) — once per token, standard ERC-20
 *   2. PERMIT2.approve(dollar, universalRouter, max, never-expires)
 */
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;
const PERMIT2_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

/** Path-based V4 quote (multi-hop): bytes path + exactAmount in. */
const V4_QUOTER_PATH_ABI = parseAbi([
  "function quoteExactInput(bytes path, uint256 exactAmount) returns (uint256 amountOut, uint256 gasEstimate)",
]);

/** V4 quote for a dollar-token → token buy through the pool (single hop). */
async function quoteExactInV4(pool, currencyIn, amountInRaw, chainKey = "ethereum") {
  const dep = getChain(chainKey);
  const { poolKey } = pool;
  // zeroForOne = "currency0 is the input". For dollar-quote pools the dollar
  // sits as currency1 (token/dollar sorted), so this is false; for ETH pools
  // ETH is currency0 → true.
  const zeroForOne = getAddress(poolKey.currency0).toLowerCase() === getAddress(currencyIn).toLowerCase();
  const { result } = await client(chainKey).simulateContract({
    address: dep.v4.quoter, abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle",
    args: [{
      poolKey: {
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks,
      },
      zeroForOne,
      exactAmount: amountInRaw,
      hookData: "0x",
    }],
  });
  return result[0];
}
function v4CurrencyOut(pool, currencyIn) {
  const c0 = getAddress(pool.poolKey.currency0).toLowerCase();
  const cin = getAddress(currencyIn).toLowerCase();
  return c0 === cin ? pool.poolKey.currency1 : pool.poolKey.currency0;
}

export async function buyDipWithDollar(signer, tokenAddress, amountUsd, { slippagePct = 3, pool = null, chainKey = "ethereum" } = {}) {
  const token = getAddress(tokenAddress);
  const dep = getChain(chainKey);
  const dollar = getAddress(dep.dollar);

  // Resolve the venue: explicit override → best V4 → error (V3 dollar-pool
  // support is not wired; these pools are V4-only in practice on 4663).
  let venue = pool;
  if (!venue) {
    venue = await findBestV4Pool(token, chainKey).catch(() => null);
    if (!venue) throw new Error(`no V4 pool found for ${token} on ${dep.name} — dollar-token buys need a V4 pool`);
  }
  const pk = venue.poolKey;
  const c0 = getAddress(pk.currency0).toLowerCase();
  const c1 = getAddress(pk.currency1).toLowerCase();
  const tokenL = token.toLowerCase();
  const dollarL = dollar.toLowerCase();
  // Pool must be exactly {token, dollar}; direction: dollar in → token out.
  if (!((c0 === dollarL && c1 === tokenL) || (c0 === tokenL && c1 === dollarL))) {
    throw new Error(`pool ${venue.poolId} is not a dollar/token pair — can't buy with the dollar token`);
  }

  const amountInRaw = BigInt(Math.round(amountUsd * 10 ** dep.dollarDecimals));
  const walletBalance = await getErc20Balance(dollar, signer.address, chainKey).catch(() => 0);
  if (walletBalance < amountUsd) {
    throw new Error(`insufficient ${dep.name} dollar balance (have ${walletBalance.toFixed(2)}, need ${amountUsd.toFixed(2)})`);
  }
  const quotedOut = await quoteExactInV4(venue, dollar, amountInRaw, chainKey);
  if (quotedOut <= 0n) throw new Error(`V4 quote returned 0 tokens out for ${tokenAddress} — refusing to send a doomed tx`);
  const bps = BigInt(Math.round(slippagePct * 100));
  const amountOutMinimum = quotedOut - (quotedOut * bps) / 10000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  // Permit2 allowance: UR pulls the dollar from the wallet via Permit2, so the
  // wallet must (a) have ERC-20-approved PERMIT2 for the dollar and (b) have a
  // Permit2 allowance for dollar → universal router. Both idempotent checks.
  const [erc20Allowance, p2] = await Promise.all([
    client(chainKey).readContract({ address: dollar, abi: ERC20_ABI, functionName: "allowance", args: [signer.address, PERMIT2_ADDRESS] }).catch(() => 0n),
    client(chainKey).readContract({ address: PERMIT2_ADDRESS, abi: PERMIT2_ABI, functionName: "allowance", args: [signer.address, dollar, dep.v4.universalRouter] }).catch(() => ({ amount: 0n, expiration: 0n })),
  ]);
  if (erc20Allowance < amountInRaw) {
    console.log(`[dip-swap] approving Permit2 to spend ${dep.dollarSymbol ?? "dollar"} for ${signer.address}`);
    const approveTx = await signer.callContract({ address: dollar, abi: ERC20_ABI, functionName: "approve", args: [PERMIT2_ADDRESS, MAX_UINT160] });
    await assertTxSucceeded(approveTx, chainKey);
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (p2.amount < amountInRaw || BigInt(p2.expiration ?? 0) <= nowSec) {
    console.log(`[dip-swap] setting Permit2 allowance: ${dep.dollarSymbol ?? "dollar"} → universal router`);
    const p2Tx = await signer.callContract({ address: PERMIT2_ADDRESS, abi: PERMIT2_ABI, functionName: "approve", args: [dollar, dep.v4.universalRouter, MAX_UINT160, MAX_UINT48] });
    await assertTxSucceeded(p2Tx, chainKey);
  }

  // Path: single hop dollar → token via the pool (PathKey library resolves the
  // pool + direction from currencyIn + {intermediateCurrency, fee, ts, hooks}).
  const swapParams = buildV4ExactInPathPayload({
    currencyIn: dollar, token, fee: pk.fee, tickSpacing: pk.tickSpacing, hooks: pk.hooks,
    amountIn: amountInRaw, amountOutMinimum,
  });
  const actions = "0x070b0e"; // SWAP_EXACT_IN, SETTLE, TAKE
  const settleParams = encodeAbiParameters(parseAbiParameters("address currency, uint256 amount, bool payerIsUser"), [dollar, 0n, true]);
  const takeParams = encodeAbiParameters(parseAbiParameters("address currency, address recipient, uint256 amount"), [token, getAddress(signer.address), 0n]);
  const v4Payload = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [swapParams, settleParams, takeParams]]);
  const dollarSymbol = dep.dollarSymbol ?? "dollar";

  console.log(`[dip-swap] Swapping $${amountUsd.toFixed(2)} ${dollarSymbol} → ${token} via V4 pool ${venue.poolId.slice(0, 12)}… on ${dep.name} (fee ${pk.fee}, min out ${Number(quotedOut) / 1e18} tokens)`);
  const txHash = await signer.callContract({
    address: dep.v4.universalRouter,
    abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
    functionName: "execute",
    args: ["0x10", [v4Payload], deadline],
    value: 0n,
  });
  await assertTxSucceeded(txHash, chainKey);
  // Cost ledger: the wallet paid the chain's dollar token (USDG/USDC), not
  // ETH. Return the true spend so callers record an honest trade row —
  // eth_spent is converted at the live rate by the caller if needed.
  return { txHash, pool: venue, quotedOut, amountOutMinimum, usd_spent: amountUsd, dollar_spent: amountUsd, dollarSymbol: dep.dollarSymbol ?? "dollar" };
}

/**
 * True when the venue is a V4 pool whose two currencies are exactly the
 * chain's dollar token and the given token (no ETH side) — i.e. the only way
 * to buy is to pay with the dollar token itself.
 */
export function isDollarQuotePool(venue, tokenAddress, chainKey = "ethereum") {
  const dep = getChain(chainKey);
  if (!venue || venue.kind !== "v4" || !venue.poolKey) return false;
  const c0 = getAddress(venue.poolKey.currency0).toLowerCase();
  const c1 = getAddress(venue.poolKey.currency1).toLowerCase();
  const tokenL = getAddress(tokenAddress).toLowerCase();
  const dollarL = getAddress(dep.dollar).toLowerCase();
  const ethL = ETH_ADDRESS;
  const wethL = dep.weth.toLowerCase();
  const isTokenDollar = (c0 === tokenL && c1 === dollarL) || (c0 === dollarL && c1 === tokenL);
  const isTokenEth = (c0 === tokenL && (c1 === ethL || c1 === wethL)) || ((c0 === ethL || c0 === wethL) && c1 === tokenL);
  return isTokenDollar && !isTokenEth;
}

/**
 * Route a market buy to the right execution path based on the venue:
 *  - token/ETH pool  → buyDip() paying with native ETH (existing path)
 *  - token/dollar pool → buyDipWithDollar() paying with the chain's dollar
 *    IF the wallet holds dollars; otherwise a two-hop V3 exactInput
 *    (ETH → dollar → token) paying with native ETH — verified live for
 *    VULT on mainnet, whose only liquid pool is USDC/VULT (fee 10000).
 * Returns the same shape both inner functions return.
 */
export async function buyToken(signer, tokenAddress, amountUsd, { slippagePct = 3, pool = null, chainKey = "ethereum" } = {}) {
  const dep = getChain(chainKey);
  // ETH/USD once, up front — used by the dollar→ETH ledger conversion below
  // AND the ETH-path sizing; one source of truth for the whole buy.
  const ethUsd = await getEthUsdPrice(chainKey);
  // LONG-platform tokens (long.xyz): hooked V4 pool, no discoverable venue —
  // route through the platform path (wrap ETH → V3 WETH→stock → V4 stock→token).
  if (chainKey === "robinhood" && !pool) {
    const longVenue = await findLongVenue(tokenAddress, chainKey).catch(() => null);
    if (longVenue) {
      const result = await executeLongBuy({ signer, chainKey, venue: longVenue, tokenAddress, usdSize: amountUsd, ethUsdPrice: ethUsd, tokenDecimals: 18, slippagePct });
      return { txHash: result.leg2TxHash, wrapTxHash: result.wrapTxHash, leg1TxHash: result.leg1TxHash, pool: longVenue, quotedOut: 0n, amountOutMinimum: 0n };
    }
  }
  // Resolve the venue once so both paths agree on it.
  let venue = pool;
  if (!venue) {
    const v4 = await findBestV4Pool(tokenAddress, chainKey).catch(() => null);
    // findBestPool throws when no V3 pool exists (curve coins have NO AMM
    // pools) — catch so the curve fallback below gets its chance.
    venue = v4 ?? await findBestPool(tokenAddress, chainKey).catch(() => null);
    // A WETH venue with no live liquidity (e.g. VULT: WETH pools empty,
    // USDC/VULT pool live) is untradeable — the single-hop quote reverts.
    // Prefer the dollar-quoted V3 pool so the buy routes via the
    // ETH→dollar→token multi-hop (isDollarQuotedV3 branch below).
    // Note: findBestPool returns venues WITHOUT a `kind` field, so don't
    // gate on kind here — check liquidity only.
    if (venue?.liquidity === 0n) {
      const dollarPool = await findBestV3DollarPool(tokenAddress, chainKey).catch(() => null);
      if (dollarPool) venue = dollarPool;
    }
    // A token/token V4 pool (quote is neither ETH/WETH nor the chain dollar,
    // e.g. IF/OLY on Robinhood) cannot be paid with ETH — buildV4BuyCall
    // throws and the buy dies. When the auto-resolved venue has that shape
    // AND a real dollar-quoted V3 pool exists, prefer the dollar pool: the
    // wallet can always pay it (directly with dollars or via the multi-hop).
    // (IF's watcher dips all failed this way while a $7.3M IF/USDG V3 pool
    // sat one resolution away, 2026-09-13.)
    const v4QuoteLc = venue?.kind === "v4" && venue.poolKey
      ? getAddress(venue.poolKey.currency0).toLowerCase() === tokenAddress.toLowerCase()
        ? getAddress(venue.poolKey.currency1).toLowerCase()
        : getAddress(venue.poolKey.currency0).toLowerCase()
      : null;
    const quoteIsPayable = v4QuoteLc != null && (
      v4QuoteLc === ETH_ADDRESS ||
      v4QuoteLc === getAddress(dep.weth).toLowerCase() ||
      v4QuoteLc === getAddress(dep.dollar).toLowerCase()
    );
    if (venue?.kind === "v4" && v4QuoteLc != null && !quoteIsPayable) {
      const dollarPool = await findBestV3DollarPool(tokenAddress, chainKey).catch(() => null);
      if (dollarPool && dollarPool.liquidityUsd > 0) venue = dollarPool;
    }
  }
  if (venue == null) {
    // Neither V4 nor V3 discovery found anything — the curve branch below decides.
  } else if (venue.kind === "v4" && isDollarQuotePool(venue, tokenAddress, chainKey)) {
    // Does the wallet hold enough of the dollar to pay directly? If not,
    // fall through to the ETH→dollar→token multi-hop below (an ETH-only
    // wallet must not be blocked by a dollar-quoted venue).
    const dollarBalance = await getErc20Balance(dep.dollar, signer.address, chainKey).catch(() => 0);
    if (dollarBalance >= amountUsd) {
      // buyDipWithDollar does its own dollar-balance pre-flight.
      const r = await buyDipWithDollar(signer, tokenAddress, amountUsd, { slippagePct, pool: venue, chainKey });
      // Ledger unit is ETH-equivalent: the wallet paid dollars, but the trade
      // ledger (eth_spent) is consumed as ETH by P/L + autosell math.
      return { ...r, eth_spent: (r.usd_spent ?? amountUsd) / ethUsd };
    }
    const mh = await buyDipMultiHop(signer, tokenAddress, amountUsd, { slippagePct, pool: venue, chainKey });
    return { ...mh, eth_spent: (mh.usd_spent ?? amountUsd) / ethUsd };
  }
  if (venue != null && venue.kind === "v3" && isDollarQuotedV3(venue, tokenAddress, chainKey)) {
    // V3 dollar-quoted venue (e.g. VULT's USDC/VULT pool on mainnet): the
    // wallet can't pay a V3 pool with the dollar directly through our paths,
    // so always buy via the ETH→dollar→token multi-hop.
    const result = await buyDipMultiHop(signer, tokenAddress, amountUsd, { slippagePct, pool: venue, chainKey });
    return { ...result, eth_spent: amountUsd / ethUsd };
  }
  // V4 + V3 discovery failed (or found nothing payable): if this token is an
  // IMD-launchpad curve coin, buy through the curve (hookData = our wallet).
  // Curve state (virtualImd/virtualCoin) comes from the launchpad indexer;
  // expected-out is curve math, never a quoter (quoters revert on curve pools).
  const curveState = await getCurveCoinState(tokenAddress, chainKey).catch(() => null);
  if (curveState) {
    const imdPerEth = await getImdPerEth(chainKey).catch(() => null);
    if (!imdPerEth) throw new Error(`curve buy for ${tokenAddress}: can't price IMD (ETH/IMD pool unavailable)`);
    const ethAmountWei = BigInt(Math.round((amountUsd / ethUsd) * 1e18));
    const balanceWei = await signer.getEthBalanceWei();
    if (balanceWei < ethAmountWei) {
      throw new Error(`insufficient ETH balance (have ${Number(balanceWei) / 1e18}, need ${Number(ethAmountWei) / 1e18})`);
    }
    const result = await buyCurveCoin(signer, tokenAddress, ethAmountWei, {
      slippagePct, chainKey, curveState, imdPerEth, universalRouter: dep.v4.universalRouter,
    });
    return { ...result, eth_spent: Number(ethAmountWei) / 1e18 };
  }
  const ethAmountWei = BigInt(Math.round((amountUsd / ethUsd) * 1e18));
  // Pre-flight ETH balance guard (was in the watcher; lives here so every
  // ETH-path caller gets it).
  const balanceWei = await signer.getEthBalanceWei();
  if (balanceWei < ethAmountWei) {
    throw new Error(`insufficient ETH balance (have ${Number(balanceWei) / 1e18}, need ${Number(ethAmountWei) / 1e18})`);
  }
  const result = await buyDip(signer, tokenAddress, ethAmountWei, { slippagePct, pool: venue, chainKey });
  return { ...result, eth_spent: Number(ethAmountWei) / 1e18 };
}

// ── IMD-launchpad curve helpers (used by buyToken's curve branch) ─────────────
let _curveCoinsCache = { at: 0, coins: null };
export async function getCurveCoinState(tokenAddress, chainKey) {
  if (chainKey !== "ethereum") return null;
  const token = getAddress(tokenAddress).toLowerCase();
  const now = Date.now();
  if (!_curveCoinsCache.coins || now - _curveCoinsCache.at > 120_000) {
    const d = await fetch(IMD_INDEXER_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: '{ coins(limit: 1000) { items { address virtualImd virtualCoin } } }' }),
      signal: AbortSignal.timeout(12000),
    }).then(r => r.json()).catch(() => null);
    if (d?.data?.coins?.items) {
      _curveCoinsCache = { at: now, coins: new Map(d.data.coins.items.map(c => [String(c.address).toLowerCase(), c])) };
    }
  }
  const coin = _curveCoinsCache.coins?.get(token);
  if (!coin) return null;
  return { virtualImd: BigInt(coin.virtualImd), virtualCoin: BigInt(coin.virtualCoin) };
}
let _imdPerEthCache = { at: 0, value: 0 };
export async function getImdPerEth(chainKey) {
  const now = Date.now();
  if (now - _imdPerEthCache.at < 60_000) return _imdPerEthCache.value;
  // ETH/IMD spot from the 1% pool slot0 (currency0=ETH): sqrtPriceX96 → IMD per ETH
  const dep = getChain(chainKey);
  const c = client(chainKey);
  const slot0 = await c.readContract({ address: dep.v4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [IMD_ETH_POOL_ID] });
  const sqrtPriceX96 = slot0[0];
  // price = (sqrtPriceX96/2^96)^2 = IMD per ETH (currency1/currency0)
  const p = Number(sqrtPriceX96) / 2 ** 96;
  const imdPerEth = p * p;
  _imdPerEthCache = { at: Date.now(), value: imdPerEth };
  return imdPerEth;
}

/**
 * True when `venue` is a V3 pool whose two tokens are exactly the chain's
 * dollar token and the given token (no WETH side) — the V3 analogue of
 * isDollarQuotePool().
 */
export function isDollarQuotedV3(venue, tokenAddress, chainKey = "ethereum") {
  const dep = getChain(chainKey);
  if (!venue || venue.kind !== "v3" || !venue.token0 || !venue.token1) return false;
  const t0 = getAddress(venue.token0).toLowerCase();
  const t1 = getAddress(venue.token1).toLowerCase();
  const tokenL = getAddress(tokenAddress).toLowerCase();
  const dollarL = getAddress(dep.dollar).toLowerCase();
  const wethL = getAddress(dep.weth).toLowerCase();
  const isTokenDollar = (t0 === tokenL && t1 === dollarL) || (t0 === dollarL && t1 === tokenL);
  const isTokenWeth = (t0 === tokenL && t1 === wethL) || (t0 === wethL && t1 === tokenL);
  return isTokenDollar && !isTokenWeth;
}

/**
 * Two-hop V3 buy: native ETH → chain dollar → token, through SwapRouter02's
 * exactInput with an encoded path. Used when the token's only liquid venue is
 * dollar-quoted (e.g. VULT's USDC/VULT pool on mainnet) and the wallet holds
 * no dollars. The dollar-leg pool (WETH/dollar, 0.05% tier) is resolved live;
 * the token-leg pool is the venue. msg.value wraps-and-pays the router
 * itself (same proven pattern as the V3 single-hop); refundETH returns
 * any unused ETH; mid-path failure reverts atomically.
 */
export async function buyDipMultiHop(signer, tokenAddress, amountUsd, { slippagePct = 3, pool = null, chainKey = "ethereum" } = {}) {
  const token = getAddress(tokenAddress);
  const dep = getChain(chainKey);
  const dollar = getAddress(dep.dollar);

  // Token leg: the dollar-quoted venue (V3 address or V4 poolId? V4 pools are
  // handled by buyDipWithDollar's V4 path — this function is V3-only and
  // requires a V3 pool address.)
  if (!pool || pool.kind !== "v3") {
    throw new Error(`buyDipMultiHop needs a V3 dollar-quoted pool, got ${pool?.kind ?? "null"} — V4 dollar pools route via buyDipWithDollar`);
  }
  const tokenFee = Number(pool.fee);
  const tokenIsToken0 = pool.token0.toLowerCase() === token.toLowerCase();
  if (!tokenIsToken0 && pool.token1.toLowerCase() !== token.toLowerCase()) {
    throw new Error(`pool ${pool.address} does not contain token ${token}`);
  }

  // Dollar leg: best WETH/dollar pool (0.05% first — deepest tier for stables).
  const dollarFee = 500;
  const c = client(chainKey);
  const wethDollarPool = await c.readContract({
    address: dep.v3.factory, abi: parseAbi(["function getPool(address,address,uint24) view returns (address)"]),
    functionName: "getPool", args: [dep.weth, dollar, dollarFee],
  });
  if (!wethDollarPool || wethDollarPool === "0x0000000000000000000000000000000000000000") {
    throw new Error(`no WETH/dollar V3 pool at fee ${dollarFee} on ${dep.name} — cannot build the ETH→dollar hop`);
  }

  const ethUsd = await getEthUsdPrice(chainKey);
  const ethAmountWei = BigInt(Math.round((amountUsd / ethUsd) * 1e18));
  const balanceWei = await signer.getEthBalanceWei();
  if (balanceWei < ethAmountWei) {
    throw new Error(`insufficient ETH balance (have ${Number(balanceWei) / 1e18}, need ${Number(ethAmountWei) / 1e18})`);
  }

  // Quote the full path ETH→dollar→token via QuoterV2's multi-hop quote.
  const path = encodePacked(
    ["address", "uint24", "address", "uint24", "address"],
    [dep.weth, dollarFee, dollar, tokenFee, token],
  );
  const { result } = await c.simulateContract({
    address: dep.v3.quoterV2, abi: QUOTER_PATH_ABI, functionName: "quoteExactInput",
    args: [path, ethAmountWei],
  });
  const quotedOut = result[0];
  if (quotedOut <= 0n) throw new Error(`multi-hop quote returned 0 for ${tokenAddress} — refusing to send a doomed tx`);
  const bps = BigInt(Math.round(slippagePct * 100));
  const amountOutMinimum = quotedOut - (quotedOut * bps) / 10000n;

  const params = {
    path, recipient: signer.address, amountIn: ethAmountWei, amountOutMinimum,
  };
  // Same no-explicit-wrap pattern as the single-hop: msg.value wraps-and-pays
  // the router itself (verified live on Base 2026-09-09 via debug_traceCall);
  // refundETH returns unused ETH. SwapRouter02's multicall(bytes[]) and
  // ExactInput carry no deadline — slippage min-out is the guard, matching
  // what Uniswap's frontend sends for multi-hop routes.
  const exactInputCalldata = encodeFunctionData({
    abi: ROUTER_ABI, functionName: "exactInput", args: [params],
  });
  const refundETHCalldata = encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" });

  console.log(`[dip-swap] Swapping ${Number(ethAmountWei) / 1e18} ETH ($${amountUsd.toFixed(2)}) → ${dep.dollarSymbol ?? "dollar"} → ${token} via V3 multi-hop (WETH/dollar fee ${dollarFee} + token leg fee ${tokenFee}, min out ${formatUnits(quotedOut, 18)})`);

  const txHash = await signer.callContract({
    address: dep.v3.swapRouter02, abi: ROUTER_ABI, functionName: "multicall",
    args: [[exactInputCalldata, refundETHCalldata]], value: ethAmountWei,
  });
  await assertTxSucceeded(txHash, chainKey);

  return { txHash, pool, quotedOut, amountOutMinimum };
}

/**
 * Build the exact Universal Router V4_SWAP call (address/abi/functionName/args/value)
 * for a native-ETH -> token buy through `venue`. Shared by buyDip() (which
 * signs and sends it) and scripts/test-v4-execution.mjs (which only
 * eth_estimateGas's it) — kept as ONE function so the dry-run script can
 * never drift from what a real buy actually sends (it did once: the dry-run
 * duplicated this logic by hand and went stale the moment the hooked-pool
 * fix below was added).
 */
export async function buildV4BuyCall(venue, tokenAddress, ethAmountWei, { slippagePct = 3, recipient, chainKey = "ethereum" }) {
  const token = getAddress(tokenAddress);
  const dep = getChain(chainKey);

  // The quoter values the input in the pool's currencyIn. When currency0 is
  // NOT native ETH (token/token pool, e.g. SIRIUS/USDG on Robinhood), sending
  // native ETH would swap the wrong asset and settle nothing the router owns
  // — it reverted PoolNotInitialized live. Wrap ETH → currency0 first, swap
  // currency0 → token, then unwrap any unused WETH. All three legs run inside
  // ONE execute() call: a partial failure reverts atomically (no stranded
  // WETH), and quote/slip/settle all denominate in currency0.
  const currency0 = getAddress(venue.poolKey.currency0);
  const ethIsCurrency0 = currency0.toLowerCase() === ETH_ADDRESS;
  if (!ethIsCurrency0 && currency0.toLowerCase() !== dep.weth.toLowerCase()) {
    throw new Error(`V4 pool input currency ${currency0} is neither native ETH nor ${dep.name}'s WETH (${dep.weth}) — cannot buy with ETH`);
  }
  const quotedOut = await quoteBuyV4(venue, ethAmountWei, chainKey);
  if (quotedOut <= 0n) {
    throw new Error(`V4 quote returned 0 tokens out for ${tokenAddress} — pool has no liquidity in the swap direction; refusing to send a doomed tx`);
  }
  const bps = BigInt(Math.round(slippagePct * 100));
  const amountOutMinimum = quotedOut - (quotedOut * bps) / 10000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  // Universal Router V4_SWAP (0x10) per the official routing guide. Two
  // shapes depending on whether the pool has a hook:
  //  - unhooked: SWAP_EXACT_IN_SINGLE(0x06), SETTLE_ALL(0x0c), TAKE_ALL(0x0f)
  //    (verified working on mainnet/Base).
  //  - hooked: SWAP_EXACT_IN(0x07), SETTLE(0x0b), TAKE(0x0e) — the generic
  //    path-based swap. At least one real Pons-launcher hook on Robinhood
  //    Chain rejects SWAP_EXACT_IN_SINGLE but accepts this shape, matching
  //    exactly what Uniswap's own frontend sends for that pool.
  // TAKE_ALL/TAKE both deliver the output directly to msg.sender — no
  // SWEEP command needed (and a trailing SWEEP reverts InsufficientToken,
  // because the router balance is already empty).
  // token/token pool (currency0 = WETH, e.g. SIRIUS/USDG, OPAI on Robinhood):
  // The router's WRAP command (0x0c) is BROKEN on Robinhood Chain — every
  // execute() containing WRAP reverts (isolated live: UR WRAP alone fails for
  // both recipient variants while WETH.deposit() passes, 2026-09-11). So for
  // WETH-quoted pools we do NOT wrap inside execute(): the caller must wrap
  // via a direct WETH.deposit() first, and the UR executes a pure-WETH swap
  // funded from the wallet (payerIsUser=true).
  const isHooked = venue.poolKey.hooks?.toLowerCase() !== ETH_ADDRESS;
  const wrapRequired = !ethIsCurrency0;
  // commands defaults to the plain V4_SWAP(0x10) wrapper — only the wrapFirst
  // path prepends WRAP_ETH (0x0c) → "0x0c10". Left unset, the normal ETH-pool
  // branches sent `undefined` into execute() and viem crashed encoding it
  // ("Cannot read properties of undefined (reading 'length')" — trades 114-116).
  let commands = "0x10", actions, swapParams, settleParams, takeParams;
  if (wrapRequired) {
    // Wrapped-ETH path (no UR WRAP command — broken on Robinhood): the caller
    // has already wrapped (wrapRequired=true means the caller deposits ETH→WETH
    // directly and approves Permit2 before sending this call). The swap leg
    // settles from the wallet's own WETH balance (payerIsUser=true).
    commands = "0x10";
    actions = "0x070b0e";
    // Path input currency is WETH (the pool's currency0).
    swapParams = buildV4ExactInPathPayload({
      currencyIn: venue.poolKey.currency0, // WETH
      token: venue.poolKey.currency1, fee: venue.poolKey.fee, tickSpacing: venue.poolKey.tickSpacing, hooks: venue.poolKey.hooks,
      amountIn: ethAmountWei, amountOutMinimum,
    });
    settleParams = encodeAbiParameters(parseAbiParameters("address currency, uint256 amount, bool payerIsUser"), [venue.poolKey.currency0, 0n, true]);
    takeParams = encodeAbiParameters(parseAbiParameters("address currency, address recipient, uint256 amount"), [token, recipient, 0n]);
  } else if (isHooked) {
    actions = "0x070b0e";
    swapParams = buildV4ExactInPathPayload({
      token: venue.poolKey.currency1, fee: venue.poolKey.fee, tickSpacing: venue.poolKey.tickSpacing, hooks: venue.poolKey.hooks,
      amountIn: ethAmountWei, amountOutMinimum,
    });
    settleParams = encodeAbiParameters(parseAbiParameters("address currency, uint256 amount, bool payerIsUser"), [ETH_ADDRESS, 0n, true]);
    takeParams = encodeAbiParameters(parseAbiParameters("address currency, address recipient, uint256 amount"), [token, recipient, 0n]);
  } else {
    actions = "0x060c0f";
    swapParams = encodeAbiParameters(
      parseAbiParameters("(address,address,uint24,int24,address), bool, uint128, uint128, bytes"),
      [[venue.poolKey.currency0, venue.poolKey.currency1, venue.poolKey.fee, venue.poolKey.tickSpacing, venue.poolKey.hooks],
        true, ethAmountWei, amountOutMinimum, "0x"],
    );
    settleParams = encodeAbiParameters(parseAbiParameters("address, uint256"), [venue.poolKey.currency0, ethAmountWei]);
    takeParams = encodeAbiParameters(parseAbiParameters("address, uint256"), [token, amountOutMinimum]); // min-out = slippage guard
  }
  const v4Payload = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [swapParams, settleParams, takeParams]]);
  // When the pool is WETH-quoted, the UR call is sent with NO msg.value (the
  // caller pre-wrapped); native-ETH pools still attach the ETH.
  const inputs = [v4Payload];

  return {
    call: {
      address: dep.v4.universalRouter,
      abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
      functionName: "execute",
      args: [commands, inputs, deadline],
      value: wrapRequired ? 0n : ethAmountWei,
    },
    quotedOut, amountOutMinimum, isHooked,
    // wrapRequired=true → the CALLER must first: (1) WETH.deposit{value}(amount)
    // and (2) Permit2-approve the router to spend the wallet's WETH. Both are
    // handled by sendV4Buy() below.
    wrapRequired,
  };
}

/**
 * Send a V4 buy, handling the Robinhood WETH-wrap quirk. On chains where the
 * router's WRAP command works, this is a single execute() with msg.value. On
 * Robinhood (WRAP broken, live-isolated 2026-09-11) it instead:
 *   1. deposits ETH→WETH directly (WETH.deposit works; the router's does not)
 *   2. Permit2-approves the router to pull the wallet's WETH
 *   3. sends the V4 swap funded from the wallet (payerIsUser=true, value 0)
 * Callers get the same { txHash, quotedOut, ... } shape either way.
 */
export async function sendV4Buy(signer, venue, token, ethAmountWei, { slippagePct = 3, chainKey = "ethereum" } = {}) {
  const dep = getChain(chainKey);
  const { call, quotedOut, amountOutMinimum, wrapRequired } = await buildV4BuyCall(venue, token, ethAmountWei, { slippagePct, recipient: signer.address, chainKey });

  console.log(`[dip-swap] Swapping ${Number(ethAmountWei) / 1e18} ETH → ${token} via V4 pool ${venue.poolId.slice(0, 12)}… on ${dep.name} (fee ${venue.fee}, min out ${Number(quotedOut) / 1e18} tokens${wrapRequired ? ", pre-wrap path" : ""})`);

  if (wrapRequired) {
    // 1) Wrap ETH → WETH via direct deposit (the router's WRAP cmd is broken here)
    const wethAbi = parseAbi(["function deposit() payable"]);
    const wrapTx = await signer.callContract({ address: dep.weth, abi: wethAbi, functionName: "deposit", value: ethAmountWei });
    await assertTxSucceeded(wrapTx, chainKey);
    console.log(`[dip-swap] pre-wrap: deposited ${Number(ethAmountWei) / 1e18} ETH → WETH (${wrapTx})`);

    // 2) Permit2 chain for WETH → router (idempotent, same as the sell path)
    const c = client(chainKey);
    const [erc20Allowance, p2] = await Promise.all([
      c.readContract({ address: dep.weth, abi: ERC20_ABI, functionName: "allowance", args: [signer.address, PERMIT2_ADDRESS] }).catch(() => 0n),
      c.readContract({ address: PERMIT2_ADDRESS, abi: PERMIT2_ABI, functionName: "allowance", args: [signer.address, dep.weth, dep.v4.universalRouter] }).catch(() => ({ amount: 0n, expiration: 0n })),
    ]);
    if (erc20Allowance < ethAmountWei) {
      const t = await signer.callContract({ address: dep.weth, abi: ERC20_ABI, functionName: "approve", args: [PERMIT2_ADDRESS, MAX_UINT160] });
      await assertTxSucceeded(t, chainKey);
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (p2.amount < ethAmountWei || BigInt(p2.expiration ?? 0) <= nowSec) {
      const t = await signer.callContract({ address: PERMIT2_ADDRESS, abi: PERMIT2_ABI, functionName: "approve", args: [dep.weth, dep.v4.universalRouter, MAX_UINT160, MAX_UINT48] });
      await assertTxSucceeded(t, chainKey);
    }
  }

  const txHash = await signer.callContract(call);
  await assertTxSucceeded(txHash, chainKey);
  return { txHash, pool: venue, quotedOut, amountOutMinimum };
}

/**
 * Wait for a sent transaction to mine and throw if it reverted. Broadcasting
 * a tx and getting a hash back only means the node accepted it into the
 * pool — it does NOT mean the swap succeeded (verified live: a real dip buy
 * reverted on-chain and was still recorded as a successful trade, because
 * nothing checked the receipt). Every buyDip() caller already has a catch
 * block that records status="error" and releases any reserved budget, so
 * throwing here is sufficient — no caller changes needed.
 */
async function assertTxSucceeded(txHash, chainKey) {
  const receipt = await client(chainKey).waitForTransactionReceipt({ hash: txHash });
  recordGasForTx(txHash, chainKey).catch(() => {}); // gas ledger — best effort, never blocks the flow
  if (receipt.status !== "success") {
    throw new Error(`transaction ${txHash} reverted on-chain (status: ${receipt.status})`);
  }
}

/**
 * Find the highest-liquidity dollar-quoted V3 pool for a token (no WETH side).
 * The V3 analogue of findBestV4Pool for dollar venues — used to watch sell
 * activity on pools like VULT's USDC/VULT (mainnet, fee 10000) when the
 * WETH-side pools are empty.
 * @returns {Promise<null | { kind: "v3", address: string, token0: string, token1: string, fee: number, liquidityUsd: number }>}
 */
export async function findBestV3DollarPool(tokenAddress, chainKey = "ethereum") {
  const dep = getChain(chainKey);
  if (dep.v3.factory === ETH_ADDRESS) return null;
  const token = getAddress(tokenAddress);
  const c = client(chainKey);
  const FACTORY_ABI = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
  const POOL_ABI = parseAbi([
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function liquidity() view returns (uint128)",
    "function fee() view returns (uint24)",
  ]);
  const candidates = await Promise.all(FEE_TIERS.map(async (fee) => {
    const pool = await c.readContract({ address: dep.v3.factory, abi: FACTORY_ABI, functionName: "getPool", args: [token, dep.dollar, fee] }).catch(() => null);
    if (!pool || pool === "0x0000000000000000000000000000000000000000") return null;
    const [t0, t1, liq, s0raw] = await Promise.all([
      c.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }),
      c.readContract({ address: pool, abi: POOL_ABI, functionName: "token1" }),
      c.readContract({ address: pool, abi: POOL_ABI, functionName: "liquidity" }),
      // slot0 via raw eth_call: mainnet pools with observation-cardinality 0
      // return a slot0 that doesn't fit the 8-field ABI (bool lands at bit 255).
      c.request({ method: "eth_call", params: [{ to: pool, data: "0x3850c7bd" }, "latest"] }).catch(() => null),
    ]);
    if (liq === 0n) return null; // out-of-range — no live liquidity to watch
    const sqrtPriceX96 = s0raw ? BigInt("0x" + s0raw.slice(2, 66)) : 0n;
    const tokenIs0 = t0.toLowerCase() === token.toLowerCase();
    // Rough in-range USD liquidity for RANKING ONLY. Working in logs avoids
    // the float overflow of naive L·√P on wide-range pools (VULT: L≈1.1e18 at
    // tick 306100 overflowed Number to 1e41). Single-sided token amounts are
    // ≈ L/√P and L·√P depending on side; take logs to keep magnitudes sane.
    const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
    const logL = Math.log(Number(liq) || 1);
    const logP = Math.log(sqrtP || 1e-12);
    // token0 amount ≈ L/√P, token1 amount ≈ L·√P — take the token's side.
    const logTokenUnits = tokenIs0 ? logL - logP : logL + logP;
    const usdPerToken = Math.min(Math.max(getTokenUsdPriceFromPool(sqrtPriceX96, tokenIs0, dep.dollarDecimals), 1e-18), 1e12);
    const logTokenUsd = logTokenUnits + Math.log(usdPerToken || 1e-18);
    const liquidityUsd = 2 * Math.min(Math.exp(logTokenUsd), 1e9); // cap at $1B for ranking
    return { kind: "v3", address: pool, token0: t0, token1: t1, fee, liquidityUsd };
  }));
  const valid = candidates.filter((p) => p && p.liquidityUsd > 0);
  if (!valid.length) return null;
  return valid.sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
}

/** Token USD price from a V3 pool's slot0 where the quote is the chain dollar. */
function getTokenUsdPriceFromPool(sqrtPriceX96, tokenIs0, dollarDecimals, tokenDecimals = 18) {
  if (!sqrtPriceX96) return 0;
  const s = Number(sqrtPriceX96) / 2 ** 96;
  // sqrtPriceX96 = sqrt(raw1/raw0)·2^96 → raw = s² = raw1/raw0.
  // Whole-unit price flips with the token's side and the decimal mismatch.
  const raw = s * s;
  const usdPerToken = tokenIs0
    ? raw * 10 ** (dollarDecimals - tokenDecimals)      // quote = currency1
    : (1 / raw) * 10 ** (tokenDecimals - dollarDecimals); // quote = currency0
  return usdPerToken > 0 && Number.isFinite(usdPerToken) ? usdPerToken : 0;
}

/** Token USD spot price from a dollar-quoted V3 pool's slot0. Uses a raw
 *  eth_call for slot0 — pools with observation-cardinality 0 return a slot0
 *  that doesn't fit the 8-field ABI (same reason findBestV3DollarPool does). */
export async function getV3DollarSpotPriceUsd({ poolAddress, tokenIs0, tokenDecimals = 18, chainKey = "ethereum" }) {
  const s0raw = await client(chainKey).request({ method: "eth_call", params: [{ to: poolAddress, data: "0x3850c7bd" }, "latest"] });
  const sqrtPriceX96 = BigInt("0x" + s0raw.slice(2, 66));
  return getTokenUsdPriceFromPool(sqrtPriceX96, tokenIs0, getChain(chainKey).dollarDecimals, tokenDecimals);
}

/**
 * Execute a market buy through the given pool (V3 address or V4 poolId).
 * For V4 the swap routes through the Universal Router (native ETH in,
 * SWEEP + RECEIVE so the token lands in the wallet).
 */
export async function buyDip(signer, tokenAddress, ethAmountWei, { slippagePct = 3, pool = null, chainKey = "ethereum", curve = null } = {}) {
  const token = getAddress(tokenAddress);
  const dep = getChain(chainKey);

  // IMD-launchpad curve coins: no AMM pool exists (Dexscreener has no pairs,
  // StateView is uninitialized, quoters revert). The hook consumes the swap
  // whole; execution goes through curve-buy.mjs with hookData = our wallet
  // (verified against the launchpad UI's own tx, 2026-09-14).
  if (curve) {
    const { buyCurveCoin } = await import("./curve-buy.mjs");
    return buyCurveCoin(signer, tokenAddress, ethAmountWei, {
      slippagePct, chainKey, curveState: curve.curveState, imdPerEth: curve.imdPerEth,
      universalRouter: curve.universalRouter ?? dep.v4.universalRouter,
    });
  }

  // Resolve the venue: explicit override → best V4 → best V3
  let venue = pool;
  let venueKind = "v3";
  if (!venue) {
    const v4 = await findBestV4Pool(token, chainKey).catch(() => null);
    if (v4) {
      venue = v4;
      venueKind = "v4";
    } else {
      // No V3 pool exists for curve coins — surface a curve-specific hint
      // instead of the raw "No WETH pool found" when the curve branch was skipped.
      venue = await findBestPool(token, chainKey).catch(() => null);
      venueKind = venue ? "v3" : "none";
    }
  } else if (typeof venue === "object" && venue.kind === "v4") {
    venueKind = "v4";
  }

  if (venueKind === "v4") {
    const result = await sendV4Buy(signer, venue, token, ethAmountWei, { slippagePct, chainKey });
    return result;
  }

  const quotedOut = await quoteBuy(token, venue.fee, ethAmountWei, chainKey);
  // amountOutMinimum = quote minus slippage tolerance (basis points math to avoid floats)
  const bps = BigInt(Math.round(slippagePct * 100));
  const amountOutMinimum = quotedOut - (quotedOut * bps) / 10000n;

  const params = {
    tokenIn: dep.weth, tokenOut: token, fee: venue.fee, recipient: signer.address,
    amountIn: ethAmountWei, amountOutMinimum, sqrtPriceLimitX96: 0n,
  };

  // DO NOT call wrapETH first: the router's swap callback pays with ETH from
  // its own balance (wrapping on the spot) when it still has any — after an
  // explicit wrapETH its ETH balance is 0 and the callback transferFroms WETH
  // from the WALLET instead, reverting STF when the wallet holds none
  // (verified live on Base 2026-09-09 via debug_traceCall: failing
  // transferFrom had from=wallet, 0 WETH balance). Attaching msg.value to
  // multicall([exactInputSingle, refundETH]) lets the router wrap-and-pay
  // itself; refundETH returns any unused ETH. Matches exactly what Uniswap's
  // frontend sends through the Universal Router for this pool
  // (WRAP_ETH + swap with payerIsUser=false).
  const exactInputSingleCalldata = encodeFunctionData({
    abi: ROUTER_ABI, functionName: "exactInputSingle", args: [params],
  });
  const refundETHCalldata = encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" });

  console.log(`[dip-swap] Swapping ${Number(ethAmountWei) / 1e18} ETH → ${token} on ${dep.name} (V3 pool fee ${venue.fee}, min out ${amountOutMinimum}, multicall swap+refund, no wrap)`);

  const txHash = await signer.callContract({
    address: dep.v3.swapRouter02, abi: ROUTER_ABI, functionName: "multicall",
    args: [[exactInputSingleCalldata, refundETHCalldata]], value: ethAmountWei,
  });
  await assertTxSucceeded(txHash, chainKey);

  return { txHash, pool: venue, quotedOut, amountOutMinimum };
}
