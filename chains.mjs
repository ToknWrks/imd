/**
 * chains.mjs — per-chain deployment registry. Everything chain-specific lives
 * here: RPC endpoints (http + ws), Uniswap V4/V3 contracts, the dollar token,
 * and the ETH/USD price source.
 *
 * Verified live 2026-09-08 against 4663:
 *  - PoolManager.owner() == 0x2bad8182…46cd (canonical Uniswap deployer)
 *  - StateView.getSlot0 on the ETH/USDG pool returns a live price (tick -198116 → ETH ≈ $2,489)
 *  - V4 pool (ETH,USDG) fee=100 tickSpacing=1 confirmed via poolId derivation
 *  - Chainlink has NO feed on 4663 — ETH price derives from the ETH/USDG V4 pool
 *
 * Robinhood Chain block times are irregular (~37s avg, multi-minute idle gaps
 * observed 2026-06 by the UniswapX team) — dip detection latency is bounded by
 * that, not by this daemon.
 */
import { createPublicClient, http, webSocket, parseAbi, defineChain } from "viem";
import { mainnet, base } from "viem/chains";

const robinhood = defineChain({
  id: 4663,
  name: "Robinhood",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.mainnet.chain.robinhood.com"],
      webSocket: ["wss://rpc.mainnet.chain.robinhood.com"],
    },
  },
});

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * The Graph Studio subgraph ids Zooch's per-trade sell-size evidence reads
 * from (zooch-graph.mjs). Only populated where verified live — guessing a
 * subgraph id would silently return another chain's data or a clean-looking
 * error, so unlisted chains degrade to "unavailable" instead.
 */
const GRAPH_SUBGRAPHS = {
  ethereum: { v3: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV", v4: "DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G" },
};

const CHAIN_DEPLOYMENTS = {
  ethereum: {
    viemChain: mainnet,
    name: "Ethereum",
    httpRpc() {
      const key = process.env.ALCHEMY_API_KEY?.trim();
      return key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : "https://ethereum-rpc.publicnode.com";
    },
    wsRpc() {
      const key = process.env.ALCHEMY_API_KEY?.trim();
      if (!key) throw new Error("ALCHEMY_API_KEY is required for mainnet WebSocket event watching");
      return `wss://eth-mainnet.g.alchemy.com/v2/${key}`;
    },
    v4: {
      poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
      quoter: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203",
      stateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
      universalRouter: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
    },
    v3: {
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      v2Factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    },
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    /** The dollar asset this chain's cost-basis math prices against. */
    dollar: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    dollarDecimals: 6,
    /** IMD — the platform token (launchpad currency, ETH/IMD V4 pool in dip-swap). */
    imdToken: "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
    imdDecimals: 18,
    imdSymbol: "IMD",
    chainlinkEthUsd: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    /** How to read ETH/USD. mainnet: Chainlink feed. */
    ethPriceSource: "chainlink",
    dexscreener: "ethereum",
    geckoTerminal: "eth",
    explorer: "https://etherscan.io",
  },
  robinhood: {
    viemChain: robinhood,
    name: "Robinhood Chain",
    /**
     * Alchemy is the MAIN RPC for everything (reads, quotes, gas estimates,
     * transaction sends). The public chain RPC is Cloudflare-challenge-gated
     * (2026-09-10: even eth_getTransactionCount gets a 403 HTML page) and
     * 403s sporadically under load — unusable as a primary.
     *
     * Exception: full-range eth_getLogs. Alchemy free tier caps getLogs at a
     * 10-block range on this network, which breaks V4 Initialize poolKey
     * recovery (see getLogsRpc()). dip-swap's log lookups therefore route to
     * the public RPC explicitly.
     */
    httpRpc() {
      const key = process.env.ALCHEMY_API_KEY?.trim();
      return key ? `https://robinhood-mainnet.g.alchemy.com/v2/${key}` : "https://rpc.mainnet.chain.robinhood.com";
    },
    /**
     * Full-range eth_getLogs endpoint. Alchemy free tier caps getLogs at a
     * 10-block range on Robinhood, but the public chain RPC serves full-range
     * queries fine (verified: ATLANTIS Initialize log at block 59513186).
     * Used ONLY for the rare Initialize-log poolKey lookups — everything else
     * goes through httpRpc() (Alchemy).
     */
    getLogsRpc() {
      return "https://rpc.mainnet.chain.robinhood.com";
    },
    /**
     * The public RPC has no archive/historical-state support at all
     * (verified: eth_call/readContract at a past block returns "Missing or
     * invalid parameters"). Alchemy DOES support historical reads here even
     * though it rejects eth_getLogs entirely for this network — so this is
     * used only for historical-block reads (e.g. cost-basis reconstruction's
     * getEthUsdPriceAtBlock), never for getLogs.
     */
    archiveHttpRpc() {
      const key = process.env.ALCHEMY_API_KEY?.trim();
      return key ? `https://robinhood-mainnet.g.alchemy.com/v2/${key}` : this.httpRpc();
    },
    /**
     * Public RPC rejects WebSocket upgrades (HTTP 400). Alchemy serves
     * robinhood-mainnet WSS with the same key; without a key there is no
     * working subscription path — dip watching is unavailable, but scheduled
     * buys (HTTP polling) still work.
     */
    wsRpc() {
      const key = process.env.ALCHEMY_API_KEY?.trim();
      if (!key) throw new Error("robinhood WebSocket watching needs ALCHEMY_API_KEY with Robinhood Mainnet enabled (dashboard.alchemy.com → app → Networks)");
      return `wss://robinhood-mainnet.g.alchemy.com/v2/${key}`;
    },
    v4: {
      poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
      quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
      stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
      universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
    },
    // V3 factory/SwapRouter02 on 4663 use non-canonical addresses (see
    // UniswapX playbook chain notes); V4-first discovery means these are only
    // a fallback — fill them in from docs before enabling V3 execution there.
    v3: {
      // Uniswap v3 deployments on 4663 (developers.uniswap.org, verified live:
      // MU/WETH fee 3000 quoted 2026-09-10). Addresses are non-canonical.
      factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
      swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
      quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
      v2Factory: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f",
    },
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // official L2 Weth Gateway deployment
    dollar: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // USDG (verified on-chain; beware ticker-squatters)
    dollarDecimals: 6,
    chainlinkEthUsd: null, // no Chainlink feed on 4663
    /** ETH/USDG V4 pool whose slot0 prices ETH (fee 100, ts 1 — derived+verified). */
    ethPricePoolId: "0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e",
    ethPricePoolKey: { currency0: ZERO, currency1: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", fee: 100, tickSpacing: 1, hooks: ZERO },
    ethPriceSource: "v4pool",
    dexscreener: "robinhood",
    geckoTerminal: null, // not indexed by GeckoTerminal yet — Zooch technicals degrade to "unavailable"
    explorer: "https://robinhoodchain.blockscout.com", // verified live via a user-supplied tx link
  },
  base: {
    viemChain: base,
    name: "Base",
    httpRpc() {
      const key = process.env.ALCHEMY_API_KEY?.trim();
      return key ? `https://base-mainnet.g.alchemy.com/v2/${key}` : "https://mainnet.base.org";
    },
    wsRpc() {
      const key = process.env.ALCHEMY_API_KEY?.trim();
      if (!key) throw new Error("ALCHEMY_API_KEY is required for Base WebSocket event watching");
      return `wss://base-mainnet.g.alchemy.com/v2/${key}`;
    },
    // Verified live 2026-09-07 (scripts/verify-base.mjs): NOT the canonical
    // mainnet addresses (unlike Robinhood's Universal Router coincidence) —
    // these are Base's own deployment addresses per
    // developers.uniswap.org/contracts/{v4,v3,v2}/deployments. StateView
    // confirmed against 3 real live V4 pools (plausible slot0 pricing); V3
    // factory confirmed via a real WETH/USDC pool with nonzero liquidity.
    v4: {
      poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
      quoter: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
      stateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
      universalRouter: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
    },
    v3: {
      factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
      quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
      // Canonical Base V2 factory, verified on-chain 2026-09-10 (eth_getCode)
      // against Uniswap's official util-contracts deployment list. The two
      // typos previously here and in sniper-swap.mjs had NO code on Base.
      v2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    },
    weth: "0x4200000000000000000000000000000000000006", // OP-stack WETH predeploy, verified symbol/decimals
    dollar: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // native USDC on Base, verified symbol/decimals
    dollarDecimals: 6,
    // Aerodrome — biggest DEX on Base (verified 2026-09-09 via basescan +
    // live eth_call against LAPTOP's $1.6M USDC/LAPTOP Slipstream pool):
    aerodrome: {
      poolFactory: "0x420dd381b31aef6683db6b902084cb0ffece40da", // Aerodrome: Pool Factory (V2-style, stable/volatile)
      slipstreamFactory: "0xeC8E5342B19977B4eF8892e02D8DAEcfa1315831", // Aerodrome: SlipStream Pool Factory (CL)
      router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", // Aerodrome: Router
    },
    chainlinkEthUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // verified live via latestRoundData()
    ethPriceSource: "chainlink",
    dexscreener: "base",
    geckoTerminal: "base",
    explorer: "https://basescan.org",
  },
};

export const CHAIN_KEYS = Object.keys(CHAIN_DEPLOYMENTS);

export function getChain(key) {
  const dep = CHAIN_DEPLOYMENTS[key];
  if (!dep) throw new Error(`unknown chain "${key}" — supported: ${CHAIN_KEYS.join(", ")}`);
  return dep;
}

/** The Graph Studio subgraph ids for a chain, or null if none are verified yet. */
export function getGraphSubgraphs(chainKey = "ethereum") {
  return GRAPH_SUBGRAPHS[chainKey] ?? null;
}

// ── Clients (cached per chain + kind) ────────────────────────────────────────

const _httpClients = new Map();
/** Batched read client for a chain. */
export function httpClient(chainKey = "ethereum") {
  const dep = getChain(chainKey);
  if (!_httpClients.has(chainKey)) {
    _httpClients.set(chainKey, createPublicClient({
      chain: dep.viemChain,
      transport: http(dep.httpRpc(), { batch: { batchSize: 50, wait: 20 } }),
    }));
  }
  return _httpClients.get(chainKey);
}

const _archiveClients = new Map();
/** Client for historical-block reads, preferring Alchemy on chains whose default RPC has no archive support. */
export function getArchiveClient(chainKey = "ethereum") {
  const dep = getChain(chainKey);
  if (!_archiveClients.has(chainKey)) {
    _archiveClients.set(chainKey, createPublicClient({
      chain: dep.viemChain, transport: http(dep.archiveHttpRpc ? dep.archiveHttpRpc() : dep.httpRpc(), { batch: false, retryCount: 0 }),
    }));
  }
  return _archiveClients.get(chainKey);
}

const _analysisClients = new Map();
/** Unbatched client for Zooch's serialized high-volume scans. */
export function getAnalysisClient(chainKey = "ethereum") {
  const dep = getChain(chainKey);
  if (!_analysisClients.has(chainKey)) {
    _analysisClients.set(chainKey, createPublicClient({
      chain: dep.viemChain, transport: http(dep.httpRpc(), { batch: false, retryCount: 0 }),
    }));
  }
  return _analysisClients.get(chainKey);
}

const _logsClients = new Map();
/**
 * Client for eth_getLogs on chains whose primary RPC caps log ranges
 * (Alchemy free tier: 10 blocks on Robinhood) but where the public chain RPC
 * serves full-range getLogs. Returns the normal httpClient where no special
 * endpoint exists (ethereum mainnet etc.).
 */
export function getLogsClient(chainKey = "ethereum") {
  const dep = getChain(chainKey);
  if (!dep.getLogsRpc) return httpClient(chainKey);
  if (!_logsClients.has(chainKey)) {
    _logsClients.set(chainKey, createPublicClient({
      chain: dep.viemChain,
      transport: http(dep.getLogsRpc(), { batch: false, retryCount: 1 }),
    }));
  }
  return _logsClients.get(chainKey);
}

const _wsClients = new Map();
/** WebSocket client for event subscriptions. Throws when a chain has no WS path. */
export function getWsClient(chainKey = "ethereum") {
  const dep = getChain(chainKey);
  if (!_wsClients.has(chainKey)) {
    _wsClients.set(chainKey, createPublicClient({
      chain: dep.viemChain,
      transport: webSocket(dep.wsRpc()),
    }));
  }
  return _wsClients.get(chainKey);
}

// ── ABI fragments shared across chains ───────────────────────────────────────

export const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint16 protocolFee, uint16 lpFee)",
]);
export const CHAINLINK_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/**
 * Live ETH/USD price for a chain. Ethereum: Chainlink. Robinhood: the
 * verified ETH/USDG V4 pool's slot0 (USDG ≈ $1, 6 decimals). Result cached
 * for 30s — it feeds sell sizing, not execution math.
 */
const _priceCache = new Map(); // chainKey → { price, at }
export async function getEthUsdPriceFor(chainKey = "ethereum") {
  const dep = getChain(chainKey);
  const cached = _priceCache.get(chainKey);
  if (cached && Date.now() - cached.at < 30_000) return cached.price;

  let price;
  if (dep.ethPriceSource === "v4pool") {
    const [sqrtPriceX96] = await httpClient(chainKey).readContract({
      address: dep.v4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [dep.ethPricePoolId],
    });
    const s = Number(sqrtPriceX96) / 2 ** 96;
    price = s * s * 10 ** (18 - dep.dollarDecimals); // dollar units per 1 ETH
  } else {
    const [, answer] = await httpClient(chainKey).readContract({
      address: dep.chainlinkEthUsd, abi: CHAINLINK_ABI, functionName: "latestRoundData",
    });
    price = Number(answer) / 1e8;
  }
  _priceCache.set(chainKey, { price, at: Date.now() });
  return price;
}
