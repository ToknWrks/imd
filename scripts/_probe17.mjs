// CONFIRMED BUG SUSPICION: the public RPC ignores/weakly applies topic
// filters (19 unique pool ids returned for a single-poolId filter).
// Check whether the PUBLIC RPC supports topic filtering at all with a simple
// eth_getLogs raw request, single topic filter:
import { getLogsClient } from "../chains.mjs";
const c = getLogsClient("robinhood");
const latest = await c.getBlockNumber();
const res = await c.request({
  method: "eth_getLogs",
  params: [{
    address: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    topics: ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b"],
    fromBlock: "0x" + (latest - 3n).toString(16),
    toBlock: "0x" + latest.toString(16),
  }],
});
const ids = new Set(res.map((L) => L.topics[1]));
console.log("via raw request(): unique topic ids:", ids.size, "logs:", res.length);
console.log("first ids:", [...ids].slice(0, 3));
process.exit(0);
