// Hypothesis: the public RPC treats topics[1] correctly ONLY when hex is
// 32-byte padded, or it ignores it entirely. Direct comparison: raw request
// with topics AS VIEM SENDS THEM — capture the real outgoing body by wrapping
// global fetch.
import { createPublicClient, http, defineChain } from "viem";
const robinhood = defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (init?.body) {
    const body = JSON.parse(init.body);
    if (Array.isArray(body)) {
      for (const r of body) if (r.method === "eth_getLogs") console.log("SENT:", JSON.stringify(r.params[0].topics));
    } else if (body.method === "eth_getLogs") {
      console.log("SENT:", JSON.stringify(body.params[0]).slice(0, 300));
    }
  }
  return origFetch(url, init);
};
const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const latest = await c.getBlockNumber();
const logs = await c.getLogs({
  address: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  topics: ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b"],
  fromBlock: latest - 3n,
  toBlock: latest,
});
console.log("logs:", logs.length, "unique ids:", new Set(logs.map((L) => L.topics[1])).size);
process.exit(0);
