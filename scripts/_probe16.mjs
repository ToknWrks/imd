// CRITICAL CHECK: is the SIRIUS "pool" filter actually matching the SIRIUS
// pool only? The probe15 sample had topics[1] = 0xa63aa803… — NOT the SIRIUS
// poolId 0x3206ce1c…! The public RPC may be IGNORING topic filters.
import { getLogsClient } from "../chains.mjs";
import { keccak256, toHex } from "viem";
const c = getLogsClient("robinhood");
const TOPIC = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const latest = await c.getBlockNumber();
// Query ONLY the SIRIUS pool over 5 blocks and inspect topics[1] of results
const logs = await c.getLogs({
  address: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  topics: [TOPIC, "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b"],
  fromBlock: latest - 5n, toBlock: latest,
});
const ids = new Set(logs.map((L) => L.topics[1]));
console.log("requested SIRIUS poolId 0x3206ce1c…; got topic ids:", [...ids].slice(0, 5), "unique:", ids.size, "logs:", logs.length);
process.exit(0);
