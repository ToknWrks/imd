// Does the public RPC filter topics correctly when passed as viem's typed
// `event + args` shape (like lookupV4PoolKeyFromInitialize uses)?
import { createPublicClient, http, defineChain, parseAbi, toHex } from "viem";
const robinhood = defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const SWAP = parseAbi(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"]);
const latest = await c.getBlockNumber();
const SIRIUS = "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b";
const logs = await c.getLogs({
  address: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  event: SWAP[0],
  args: { id: SIRIUS },
  fromBlock: latest - 3n,
  toBlock: latest,
});
const ids = new Set(logs.map((L) => L.args.id));
console.log("typed getLogs: logs:", logs.length, "unique ids:", ids.size, "allSIRIUS:", [...ids].every((x) => x === SIRIUS));
process.exit(0);
