// Test raw eth_getLogs via viem request() — same JSON-RPC the client sends.
import { httpClient } from "../chains.mjs";
const c = httpClient("robinhood");
const latest = await c.getBlockNumber();
const latestHex = "0x" + latest.toString(16);
const fromHex = "0x" + (latest - 900n).toString(16);
// Raw request with fromBlock/toBlock hex strings (what viem serializes to)
try {
  const res = await c.request({
    method: "eth_getLogs",
    params: [{
      address: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
      topics: ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b"],
      fromBlock: fromHex,
      toBlock: latestHex,
    }],
  });
  console.log("raw request OK:", res.length, "logs");
} catch (e) {
  console.log("raw request FAILED:", e.message?.slice(0, 150));
}
// And via the public RPC (chains.mjs getLogsRpc) — maybe Alchemy caps ranges here
import { createPublicClient, http, defineChain } from "viem";
const robinhood = defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const pub = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
try {
  const res2 = await pub.request({
    method: "eth_getLogs",
    params: [{
      address: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
      topics: ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b"],
      fromBlock: fromHex,
      toBlock: latestHex,
    }],
  });
  console.log("public RPC OK:", res2.length, "logs");
} catch (e) {
  console.log("public RPC FAILED:", e.message?.slice(0, 150));
}
process.exit(0);
