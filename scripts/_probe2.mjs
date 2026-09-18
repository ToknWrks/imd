import { httpClient } from "../chains.mjs";
import { keccak256, toHex } from "viem";
const c = httpClient("robinhood");
const TOPIC = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const latest = await c.getBlockNumber();
const poolId = "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b";
console.log("latest:", latest.toString(), "topic:", TOPIC.slice(0, 12));
// try with topics[1] as-is (already 0x-prefixed 32-byte)
try {
  const logs = await c.getLogs({ address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", topics: [TOPIC, poolId], fromBlock: latest - 100n, toBlock: latest });
  console.log("OK with raw poolId, logs:", logs.length);
} catch (e) { console.log("FAIL raw poolId:", e.message.slice(0, 100)); }
try {
  const logs = await c.getLogs({ address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", topics: [TOPIC, poolId.padEnd(66, "0")], fromBlock: latest - 100n, toBlock: latest });
  console.log("OK with padded poolId, logs:", logs.length);
} catch (e) { console.log("FAIL padded:", e.message.slice(0, 100)); }
