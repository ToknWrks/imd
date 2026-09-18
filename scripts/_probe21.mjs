// A/B test on the SAME 3-block window: raw hex topics vs typed event+args.
// Earlier results suggest the RAW-TOPIC path through viem getLogs drops the
// topic filter ("SENT: topics:[]"). Reproduce precisely, printing the body.
import { createPublicClient, http, defineChain, parseAbi } from "viem";
const robinhood = defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (init?.body) {
    try {
      const body = JSON.parse(init.body);
      const reqs = Array.isArray(body) ? body : [body];
      for (const r of reqs) if (r.method === "eth_getLogs") console.log("SENT topics:", JSON.stringify(r.params[0].topics));
    } catch {}
  }
  return origFetch(url, init);
};
const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const SWAP = parseAbi(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"]);
const latest = await c.getBlockNumber();
const SIRIUS = "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b";

// Path A: raw topic strings (what mm-watcher currently does)
const a = await c.getLogs({
  address: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  topics: ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", SIRIUS],
  fromBlock: latest - 3n, toBlock: latest,
});
console.log("A raw-topics: logs:", a.length, "unique:", new Set(a.map((L) => L.topics[1])).size);

// Path B: typed event+args
const b = await c.getLogs({
  address: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  event: SWAP[0], args: { id: SIRIUS },
  fromBlock: latest - 3n, toBlock: latest,
});
console.log("B typed: logs:", b.length);
process.exit(0);
