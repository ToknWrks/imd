// Inspect a V4 poolId: find its Initialize event (currencies/fee/hooks) on
// ethereum + robinhood PoolManagers, then read slot0/liquidity via each chain's
// own StateView. Read-only diagnostics.
import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { mainnet } from "viem/chains";
import { readFileSync } from "fs";

try {
  const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const l of env.split("\n")) { const m = l.match(/^([^#=\s][^=]*)=(.*)$/); if (m) process.env[m[1].trim()] = m[2].trim(); }
} catch {}

const POOL_ID = "0x743a2c8b972e6631363d15b56cf5cffc900e536dc659502cda67369986f21c90";

const pmAbi = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
const svAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint16 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

const CHAINS = [
  {
    name: "ethereum",
    poolManager: "0x000000000004444c5dc75cb358380d2e3de08a90",
    stateView: "0x7ffe42c4a5deea5b0fec41c94c136cf136cf1155",
    rpc: process.env.ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : "https://ethereum-rpc.publicnode.com",
    viemChain: mainnet,
  },
  {
    name: "robinhood(4663)",
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    rpc: process.env.ALCHEMY_API_KEY ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : "https://rpc.mainnet.chain.robinhood.com",
    viemChain: { id: 4663, name: "robinhood", network: "robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } },
  },
  {
    name: "base",
    poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    stateView: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
    rpc: process.env.ALCHEMY_API_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : "https://mainnet.base.org",
    viemChain: { id: 8453, name: "base", network: "base", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://mainnet.base.org"] } } },
  },
];

for (const ch of CHAINS) {
  console.log(`\n=== ${ch.name} ===`);
  const client = createPublicClient({ chain: ch.viemChain, transport: http(ch.rpc) });
  try {
    const code = await client.getCode({ address: ch.stateView });
    console.log("StateView code size:", code ? code.length : 0);
  } catch (e) { console.log("getCode err:", String(e.message).slice(0, 80)); }

  // 1. find Initialize for this poolId (wide scan, chunked)
  let init = null;
  let latest = 0;
  try { latest = Number(await client.getBlockNumber()); } catch (e) { console.log("blockNumber err:", String(e.message).slice(0, 80)); continue; }
  console.log("latest block:", latest);
  for (let end = latest; end > 0 && !init; end -= 400_000) {
    const from = Math.max(0, end - 400_000);
    try {
      const logs = await client.getLogs({ address: ch.poolManager, abi: pmAbi, eventName: "Initialize", args: { id: POOL_ID }, fromBlock: BigInt(from), toBlock: BigInt(Math.min(end, latest)) });
      if (logs.length) { init = logs[0]; break; }
    } catch (e) {
      const msg = String(e.message);
      if (!msg.includes("response") && !msg.includes("range")) console.log(`  scan err @${from}:`, msg.slice(0, 100));
    }
  }
  if (!init) { console.log("Initialize NOT found (scanned to genesis)"); continue; }
  console.log("INITIALIZED:");
  console.log("  currency0:", init.args.currency0);
  console.log("  currency1:", init.args.currency1);
  console.log("  fee:", init.args.fee, " tickSpacing:", init.args.tickSpacing, " hooks:", init.args.hooks);
  console.log("  initBlock:", init.blockNumber.toString());

  // 2. slot0 + liquidity via this chain's StateView
  try {
    const s0 = await client.readContract({ address: ch.stateView, abi: svAbi, functionName: "getSlot0", args: [POOL_ID] });
    const lq = await client.readContract({ address: ch.stateView, abi: svAbi, functionName: "getLiquidity", args: [POOL_ID] });
    console.log("  slot0:", s0);
    console.log("  liquidity:", lq.toString());
  } catch (e) { console.log("  state read err:", String(e.message).slice(0, 120)); }

  // 3. recent swap activity (last 5000 blocks)
  try {
    const sw = await client.getLogs({ address: ch.poolManager, abi: pmAbi, eventName: "Swap", args: { id: POOL_ID }, fromBlock: BigInt(Math.max(0, latest - 5000)), toBlock: BigInt(latest) });
    console.log("  swaps last ~5000 blocks:", sw.length);
  } catch (e) { console.log("  swap scan err:", String(e.message).slice(0, 100)); }
}
