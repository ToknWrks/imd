// Interesting: via raw request() with BOTH topics → 0 logs (correct — no
// SIRIUS swaps in 3 blocks). But viem's c.getLogs() with same filter → 21 logs
// from 19 different pools. Suspect viem's getLogs does something different —
// maybe it paginates and drops the topics? Test viem getLogs again + log the
// actual params viem sends by tapping the transport.
import { createPublicClient, http, defineChain } from "viem";
const robinhood = defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
let lastBody = null;
const transport = () => http("https://rpc.mainnet.chain.robinhood.com", {
  fetchOptions: {},
  onFetch: undefined,
});
const c = createPublicClient({ chain: robinhood, transport: transport() });
const latest = await c.getBlockNumber();
const TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const logs = await c.getLogs({
  address: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  topics: [TOPIC, "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b"],
  fromBlock: latest - 3n,
  toBlock: latest,
});
const ids = new Set(logs.map((L) => L.topics[1]));
console.log("viem getLogs: unique ids:", ids.size, "logs:", logs.length);
console.log("all SIRIUS?", [...ids].every((id) => id === "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b"));
process.exit(0);
