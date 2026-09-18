/**
 * sniper-swap.mjs — multi-DEX pool discovery, quoting, and ETH→token buys.
 * Ported from toknwrks-main sniper3 (V2 / V3 / V4 / Aerodrome) onto Accumulate's
 * viem + local-signer stack. Ethereum + Base.
 */
import {
  createPublicClient,
  http,
  getAddress,
  parseAbi,
  parseEther,
  formatUnits,
  keccak256,
  encodeAbiParameters,
  encodePacked,
  encodeFunctionData,
  defineChain,
} from "viem";
import { mainnet, base } from "viem/chains";
import { findBestV4Pool, findBestV3DollarPool, buildV4BuyCall } from "./dip-swap.mjs";

export const ZERO = "0x0000000000000000000000000000000000000000";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// Robinhood Chain (4663) — Arbitrum Orbit L2, ETH gas. Defined here because
// viem has no built-in deployment (matches chains.mjs's defineChain).
const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

const V4_FEE_TICKS = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
];
const V3_FEES = [100, 500, 3000, 10000];

export const NETWORKS = {
  ethereum: {
    key: "ethereum",
    id: 1,
    name: "Ethereum",
    explorer: "https://etherscan.io",
    chain: mainnet,
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    v2Factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    v2Router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    v3Router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    v3Quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    v4PoolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    v4StateView: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227",
    v4Quoter: "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203",
    v4Router: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af",
    chainlinkEthUsd: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  },
  base: {
    key: "base",
    id: 8453,
    name: "Base",
    explorer: "https://basescan.org",
    chain: base,
    weth: "0x4200000000000000000000000000000000000006",
    // Canonical Base V2 factory — verified on-chain 2026-09-10 via eth_getCode
    // (the previous value here had NO code on Base; see chains.mjs note).
    v2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    v2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    v3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    v3Router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    v3Quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    v4PoolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    v4StateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
    v4Quoter: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
    v4Router: "0x6fF5693b99212da76ad316178a184ab56d299b43",
    aeroRouter: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
    aeroFactory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
    chainlinkEthUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  },
  robinhood: {
    key: "robinhood",
    id: 4663,
    name: "Robinhood Chain",
    explorer: "https://robinhoodchain.blockscout.com",
    chain: robinhoodChain,
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    // ETH/USDG V4 pool prices ETH on 4663 (no Chainlink feed there).
    v2Factory: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f",
    v2Router: "0x8876789976decbfcbbbe364623c63652db8c0904",
    v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    v3Router: "0xcaf681a66d020601342297493863e78c959e5cb2",
    v3Quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    v4PoolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    v4StateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    v4Router: "0x8876789976decbfcbbbe364623c63652db8c0904",
    chainlinkEthUsd: null, // no Chainlink feed on 4663 — ETH pricing uses the V4 pool
  },
};

const FACTORY_V2_ABI = parseAbi(["function getPair(address,address) view returns (address)"]);
const PAIR_V2_ABI = parseAbi(["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"]);
const V2_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
]);
const FACTORY_V3_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const POOL_V3_ABI = parseAbi([
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const V3_ROUTER_ABI = parseAbi([
  // SwapRouter02's ExactInputSingleParams has NO deadline field (that's the
  // QuoterV2 struct). Verified via debug_traceCall on Base 2026-09-09.
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function refundETH() payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);
const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const V4_QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
const UR_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const AERO_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, (address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, (address from,address to,bool stable,address factory)[] routes, address to, uint256 deadline) payable returns (uint256[] amounts)",
]);
const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const PERMIT2_ABI = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const CHAINLINK_ABI = parseAbi([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

function alchemyHttp(network) {
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (key && network.key === "ethereum") return `https://eth-mainnet.g.alchemy.com/v2/${key}`;
  if (key && network.key === "base") return `https://base-mainnet.g.alchemy.com/v2/${key}`;
  // Robinhood: the public chain RPC 403s sporadically and there is NO generic
  // public fallback — sending calls to any other chain's RPC silently returns
  // empty data ("0x") because the contracts don't exist there (this exact bug
  // made every Robinhood sell quote fail: 2026-09-10). Alchemy serves 4663.
  if (key && network.key === "robinhood") return `https://robinhood-mainnet.g.alchemy.com/v2/${key}`;
  return network.key === "base" ? "https://mainnet.base.org" : "https://ethereum-rpc.publicnode.com";
}

const clients = new Map();
export function publicClient(chainKey) {
  const network = NETWORKS[chainKey];
  if (!network) throw new Error(`unknown chain ${chainKey}`);
  if (!clients.has(chainKey)) {
    clients.set(chainKey, createPublicClient({ chain: network.chain, transport: http(alchemyHttp(network)) }));
  }
  return clients.get(chainKey);
}

export function getNetwork(chainKey) {
  const n = NETWORKS[chainKey];
  if (!n) throw new Error(`unknown chain ${chainKey} — use ethereum or base`);
  return n;
}

function sortAddr(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function v4PoolId(key) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

export async function getTokenMeta(chainKey, tokenAddress) {
  const token = getAddress(tokenAddress);
  const c = publicClient(chainKey);
  const [decimals, symbol] = await Promise.all([
    c.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
    c.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => null),
  ]);
  return { decimals, symbol };
}

export async function getEthUsd(chainKey) {
  const n = getNetwork(chainKey);
  // Robinhood has NO Chainlink feed (chains.mjs: chainlinkEthUsd = null).
  // Delegate to the chain registry's ETH/USD source (V4 ETH/USDG pool slot0
  // on 4663) instead of crashing the whole context endpoint.
  if (!n.chainlinkEthUsd) {
    const { getEthUsdPriceFor } = await import("./chains.mjs");
    return getEthUsdPriceFor(chainKey);
  }
  const c = publicClient(chainKey);
  const [, answer] = await c.readContract({
    address: n.chainlinkEthUsd,
    abi: CHAINLINK_ABI,
    functionName: "latestRoundData",
  });
  return Number(answer) / 1e8;
}

async function quoteV3(n, token, fee, amountIn) {
  const c = publicClient(n.key);
  const { result } = await c.simulateContract({
    address: n.v3Quoter,
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: n.weth, tokenOut: token, amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

async function quoteV2(n, token, amountIn) {
  const c = publicClient(n.key);
  const amounts = await c.readContract({
    address: n.v2Router,
    abi: V2_ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, [n.weth, token]],
  });
  return amounts[amounts.length - 1];
}

async function quoteAero(n, token, amountIn, stable) {
  const c = publicClient(n.key);
  const amounts = await c.readContract({
    address: n.aeroRouter,
    abi: AERO_ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, [{ from: n.weth, to: token, stable, factory: n.aeroFactory }]],
  });
  return amounts[amounts.length - 1];
}

async function quoteV4(n, key, tokenIn, amountIn) {
  const c = publicClient(n.key);
  const zeroForOne = tokenIn.toLowerCase() === key.currency0.toLowerCase();
  const { result } = await c.simulateContract({
    address: n.v4Quoter,
    abi: V4_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{
      poolKey: key,
      zeroForOne,
      exactAmount: amountIn,
      hookData: "0x",
    }],
  });
  return result[0];
}

async function findV2(n, token, amountIn) {
  const c = publicClient(n.key);
  try {
    const pair = await c.readContract({
      address: n.v2Factory,
      abi: FACTORY_V2_ABI,
      functionName: "getPair",
      args: [token, n.weth],
    });
    if (!pair || pair === ZERO) return null;
    const [r0, r1] = await c.readContract({ address: pair, abi: PAIR_V2_ABI, functionName: "getReserves" });
    const token0 = await c.readContract({ address: pair, abi: PAIR_V2_ABI, functionName: "token0" });
    const wethReserve = token0.toLowerCase() === n.weth.toLowerCase() ? r0 : r1;
    if (wethReserve === 0n) return null;
    const quotedOut = await quoteV2(n, token, amountIn);
    return {
      dex: "V2",
      label: "Uniswap V2",
      poolAddress: pair,
      fee: null,
      quotedOut,
      wethReserve: wethReserve.toString(),
    };
  } catch {
    return null;
  }
}

async function findV3(n, token, amountIn) {
  const c = publicClient(n.key);
  const found = [];
  await Promise.all(V3_FEES.map(async (fee) => {
    try {
      const pool = await c.readContract({
        address: n.v3Factory,
        abi: FACTORY_V3_ABI,
        functionName: "getPool",
        args: [token, n.weth, fee],
      });
      if (!pool || pool === ZERO) return;
      const liq = await c.readContract({ address: pool, abi: POOL_V3_ABI, functionName: "liquidity" });
      if (liq === 0n) return;
      const quotedOut = await quoteV3(n, token, fee, amountIn);
      found.push({
        dex: "V3",
        label: `Uniswap V3 ${(fee / 10000).toFixed(2)}%`,
        poolAddress: pool,
        fee,
        quotedOut,
        liquidity: liq.toString(),
      });
    } catch { /* no pool / quote fail */ }
  }));
  return found;
}

async function findV4(n, token, amountIn) {
  const c = publicClient(n.key);
  const found = [];
  const bases = [ZERO, n.weth];
  for (const baseCur of bases) {
    const [currency0, currency1] = sortAddr(token, baseCur);
    for (const { fee, tickSpacing } of V4_FEE_TICKS) {
      const key = { currency0, currency1, fee, tickSpacing, hooks: ZERO };
      const poolId = v4PoolId(key);
      try {
        const slot0 = await c.readContract({ address: n.v4StateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] });
        if (slot0[0] === 0n) continue;
        const liq = await c.readContract({ address: n.v4StateView, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [poolId] });
        if (liq === 0n) continue;
        const tokenIn = baseCur;
        const quotedOut = await quoteV4(n, key, tokenIn, amountIn);
        found.push({
          dex: "V4",
          label: `Uniswap V4 ${(fee / 10000).toFixed(2)}%${baseCur === ZERO ? " native ETH" : " WETH"}`,
          poolAddress: poolId,
          fee,
          tickSpacing,
          hooks: ZERO,
          currency0,
          currency1,
          quotedOut,
          liquidity: liq.toString(),
          usesNative: baseCur === ZERO,
        });
      } catch { /* not initialized or unquotable */ }
    }
  }
  return found;
}

async function findAero(n, token, amountIn) {
  if (!n.aeroRouter) return [];
  const found = [];
  for (const stable of [false, true]) {
    try {
      const quotedOut = await quoteAero(n, token, amountIn, stable);
      if (quotedOut > 0n) {
        found.push({
          dex: "AERODROME",
          label: `Aerodrome ${stable ? "stable" : "volatile"}`,
          poolAddress: n.aeroFactory,
          fee: null,
          stable,
          quotedOut,
        });
      }
    } catch { /* no route */ }
  }
  return found;
}

/**
 * Discover every quoteable WETH/ETH pool for `tokenAddress` and quote `ethAmount`
 * (human ETH string, e.g. "0.01") against each.
 *
 * V4 discovery merges two sources: the legacy brute-force findV4 (standard
 * fee/tick pairs, hooks=0) AND dip-swap's Dexscreener→StateView→Initialize-log
 * resolver (findBestV4Pool) — the only one that can see non-standard and
 * hooked pools (SIRIUS fee=0/ts=200 hooked 0xE5e7…, ATLANTIS fee=8388608/ts=8
 * LONG hook — all invisible to brute force; verified 2026-09-10). Result:
 * discoverPools on Robinhood previously returned 0 pools for these tokens,
 * which made the Sniper page unable to buy or sell them.
 */
export async function discoverPools(chainKey, tokenAddress, ethAmount = "0.01") {
  const n = getNetwork(chainKey);
  const token = getAddress(tokenAddress);
  const amountIn = parseEther(String(ethAmount));
  const meta = await getTokenMeta(chainKey, token);

  const [v2, v3, v4, aero, dipV4, dipV3Dollar] = await Promise.all([
    findV2(n, token, amountIn),
    findV3(n, token, amountIn),
    findV4(n, token, amountIn),
    findAero(n, token, amountIn),
    // dip-swap resolvers (same ones the dip-watcher's buys use successfully)
    findBestV4Pool(token, chainKey).catch(() => null),
    findBestV3DollarPool(token, chainKey).catch(() => null),
  ]);

  // Merge dip-swap's V4 result (keyed by poolId so brute-force dupes drop).
  if (dipV4?.poolId && !v4.some((p) => p.poolAddress === dipV4.poolId)) {
    const tokenIs0 = dipV4.currency0.toLowerCase() === token.toLowerCase();
    let quotedOut = 0n;
    // Hooked pools reject the V4 quoter — price via StateView slot0 instead
    // (same approach as long-platform.mjs: spot only, no quote).
    if (dipV4.hooks && dipV4.hooks !== ZERO) {
      const SV = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"]);
      try {
        const [sqrtPriceX96] = await publicClient(chainKey).readContract({
          address: n.v4StateView, abi: SV, functionName: "getSlot0", args: [dipV4.poolId],
        });
        if (sqrtPriceX96 > 0n) {
          const s = Number(sqrtPriceX96) / 2 ** 96;
          const dec = Number(meta.decimals ?? 18);
          const tokensOut = tokenIs0
            ? (1 / (s * s)) * 10 ** (dec - 18) // token0 → token1 per ETH
            : s * s * 10 ** (18 - dec);        // token1 ← currency0=ETH
          // hooks like the LONG hook may add a fee on output — pad generously
          const est = BigInt(Math.floor(Number(amountIn) * tokensOut * 0.8));
          if (est > 0n) {
            v4.push({
              dex: "V4", label: `Uniswap V4 ${(dipV4.fee / 10000).toFixed(2)}% hooked`,
              poolAddress: dipV4.poolId, fee: dipV4.fee, tickSpacing: dipV4.tickSpacing,
              hooks: dipV4.hooks, currency0: dipV4.currency0, currency1: dipV4.currency1,
              quotedOut: est, usesNative: dipV4.currency0 === ZERO, spotOnly: true,
            });
          }
          void SV;
        }
      } catch { /* slot0 unavailable — skip */ }
    } else {
      // Unhooked: quote through the V4 quoter with the proven struct shape.
      try {
        const { result } = await publicClient(chainKey).simulateContract({
          address: n.v4Quoter, abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle",
          args: [{
            poolKey: { currency0: dipV4.currency0, currency1: dipV4.currency1, fee: dipV4.fee, tickSpacing: dipV4.tickSpacing, hooks: dipV4.hooks },
            zeroForOne: false, exactAmount: amountIn, hookData: "0x",
          }],
        });
        if (result[0] > 0n) {
          v4.push({
            dex: "V4", label: `Uniswap V4 ${(dipV4.fee / 10000).toFixed(2)}%`,
            poolAddress: dipV4.poolId, fee: dipV4.fee, tickSpacing: dipV4.tickSpacing,
            hooks: dipV4.hooks, currency0: dipV4.currency0, currency1: dipV4.currency1,
            quotedOut: result[0], usesNative: dipV4.currency0 === ZERO,
          });
        }
      } catch { /* quoter unavailable */ }
    }
  }

  // V3 dollar-quoted pool (SIRIUS/USDG etc.) — buy path is WETH→token so a
  // dollar pool can't serve a plain ETH buy; skip it for buys but note it.
  void dipV3Dollar;

  const pools = [...(v2 ? [v2] : []), ...v3, ...v4, ...aero]
    .filter((p) => p.quotedOut && p.quotedOut > 0n)
    .sort((a, b) => (b.quotedOut > a.quotedOut ? 1 : b.quotedOut < a.quotedOut ? -1 : 0))
    .map((p) => ({
      ...p,
      quotedOut: p.quotedOut.toString(),
      quotedOutFormatted: Number(formatUnits(p.quotedOut, meta.decimals ?? 18)).toLocaleString(undefined, { maximumFractionDigits: 6 }),
    }));

  return {
    chain: n.key,
    chainName: n.name,
    explorer: n.explorer,
    token,
    symbol: meta.symbol,
    decimals: meta.decimals,
    amountIn: amountIn.toString(),
    ethAmount: String(ethAmount),
    pools,
  };
}

function minOut(quoted, slippagePct) {
  const q = BigInt(quoted);
  const bps = BigInt(Math.round(Number(slippagePct) * 100));
  return q - (q * bps) / 10000n;
}

/**
 * Execute a market buy on the selected pool using Accumulate's signer interface.
 * `pool` is one of the objects returned by discoverPools().
 */
export async function executeSniperBuy({ signer, chainKey, tokenAddress, ethAmount, slippagePct = 3, pool }) {
  const n = getNetwork(chainKey);
  const token = getAddress(tokenAddress);
  const amountIn = parseEther(String(ethAmount));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  // V4 buys build + send in one shot via dip-swap's buildV4BuyCall (it does
  // its own quoter call and handles hooked pools / token-token pools). All
  // other DEXes quote first, then send.
  if (pool.dex === "V4") {
    const venue = {
      poolId: pool.poolAddress,
      poolKey: {
        currency0: pool.currency0,
        currency1: pool.currency1,
        fee: Number(pool.fee),
        tickSpacing: Number(pool.tickSpacing),
        hooks: pool.hooks || ZERO,
      },
    };
    // Token/token V4 pool (e.g. IF/USDG, SIRIUS/USDG, ATLANTIS/MU on
    // Robinhood — none of these tokens has an ETH-quoted V4 pool): an ETH
    // buy cannot route through it directly. Delegate to dip-swap's buyToken
    // dispatcher, which picks the proven path (wallet dollars → V4 dollar
    // pool; else ETH→dollar→token V3 multi-hop; LONG tokens → platform path).
    const c0 = (pool.currency0 || ZERO).toLowerCase();
    const c1 = (pool.currency1 || ZERO).toLowerCase();
    const wethLc = n.weth.toLowerCase();
    const ethInvolved = c0 === ZERO || c0 === wethLc || c1 === wethLc;
    if (!ethInvolved) {
      const { buyToken, getEthUsdPrice } = await import("./dip-swap.mjs");
      const ethUsd = await getEthUsdPrice(chainKey);
      if (!(ethUsd > 0)) throw new Error("ETH/USD price unavailable — cannot size a routed buy");
      const usdSize = Number(ethAmount) * ethUsd;
      const result = await buyToken(signer, token, usdSize, { slippagePct, pool: null, chainKey });
      return { txHash: result.txHash, quotedOut: result.quotedOut ?? 0n, amountOutMinimum: result.amountOutMinimum ?? 0n, dex: "ROUTED", label: "dip-swap routed (token/dollar pool)" };
    }
    // sendV4Buy (not raw buildV4BuyCall): it handles chains where the router's
    // WRAP command is broken (Robinhood) by pre-wrapping via WETH.deposit +
    // Permit2 approvals, then sending the swap with payerIsUser=true.
    const { sendV4Buy } = await import("./dip-swap.mjs");
    const result = await sendV4Buy(signer, venue, token, amountIn, { slippagePct, chainKey });
    return { txHash: result.txHash, quotedOut: result.quotedOut, amountOutMinimum: result.amountOutMinimum, dex: pool.dex, label: pool.label };
  }

  let quotedOut;
  if (pool.dex === "V3") {
    quotedOut = await quoteV3(n, token, pool.fee, amountIn);
  } else if (pool.dex === "AERODROME") {
    quotedOut = await quoteAero(n, token, amountIn, !!pool.stable);
  } else {
    quotedOut = await quoteV2(n, token, amountIn);
  }

  if (!quotedOut || quotedOut === 0n) throw new Error("quote returned 0 — aborting buy");
  const amountOutMinimum = minOut(quotedOut, slippagePct);

  let txHash;
  if (pool.dex === "V3") {
    // Same fix as buyDip() in dip-swap.mjs: calling exactInputSingle directly
    // with msg.value attached does NOT use the attached ETH — the swap
    // callback transferFroms WETH from the WALLET and reverts STF when the
    // wallet holds no WETH (verified live on Base 2026-09-09 via
    // debug_traceCall: failing transferFrom had from=wallet). The router pays
    // from its own ETH balance (wrapping on the spot) as long as it still HAS
    // ETH — so attach msg.value to multicall([exactInputSingle, refundETH])
    // and never call wrapETH first (that zeroes the router's ETH balance and
    // forces the failing wallet-pull path). Matches what Uniswap's frontend
    // sends: WRAP_ETH + swap with payerIsUser=false.
    const exactInputSingleCalldata = encodeFunctionData({
      abi: V3_ROUTER_ABI, functionName: "exactInputSingle",
      args: [{
        tokenIn: n.weth,
        tokenOut: token,
        fee: pool.fee,
        recipient: signer.address,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      }],
    });
    const refundETHCalldata = encodeFunctionData({
      abi: V3_ROUTER_ABI, functionName: "refundETH",
    });
    txHash = await signer.callContract({
      address: n.v3Router,
      abi: V3_ROUTER_ABI,
      functionName: "multicall",
      args: [[exactInputSingleCalldata, refundETHCalldata]],
      value: amountIn,
    });
  } else if (pool.dex === "AERODROME") {
    txHash = await signer.callContract({
      address: n.aeroRouter,
      abi: AERO_ROUTER_ABI,
      functionName: "swapExactETHForTokens",
      args: [
        amountOutMinimum,
        [{ from: n.weth, to: token, stable: !!pool.stable, factory: n.aeroFactory }],
        signer.address,
        deadline,
      ],
      value: amountIn,
    });
  } else if (pool.dex === "V4") {
    // Route through dip-swap's buildV4BuyCall — the SAME builder the
    // dip-watcher's proven buys use. It handles hooked pools (SWAP_EXACT_IN
    // path shape — the legacy 0x06 single shape reverts on hooked pools),
    // token/token pools needing WRAP_ETH, and quote failures. The old inline
    // encoding here only worked for unhooked native-ETH pools.
    const venue = {
      poolId: pool.poolAddress,
      poolKey: {
        currency0: pool.currency0,
        currency1: pool.currency1,
        fee: Number(pool.fee),
        tickSpacing: Number(pool.tickSpacing),
        hooks: pool.hooks || ZERO,
      },
    };
    // sendV4Buy handles chains where the router's WRAP command is broken
    // (Robinhood): pre-wraps via WETH.deposit + Permit2, then swaps.
    const { sendV4Buy } = await import("./dip-swap.mjs");
    const result = await sendV4Buy(signer, venue, token, amountIn, { slippagePct, chainKey });
    quotedOut = result.quotedOut;
    amountOutMinimum = result.amountOutMinimum;
    txHash = result.txHash;
  } else {
    txHash = await signer.callContract({
      address: n.v2Router,
      abi: V2_ROUTER_ABI,
      functionName: "swapExactETHForTokens",
      args: [amountOutMinimum, [n.weth, token], signer.address, deadline],
      value: amountIn,
    });
  }

  return { txHash, quotedOut, amountOutMinimum, dex: pool.dex, label: pool.label };
}
