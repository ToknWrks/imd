// Reproduce the watcher's exact call path to find the "not a valid request object" cause
import { httpClient } from "../chains.mjs";
import { keccak256, toHex } from "viem";
const c = httpClient("robinhood");
const TOPIC = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const latest = await c.getBlockNumber();
const latestNum = Number(latest);
const dep = (await import("../chains.mjs")).getChain("robinhood");
console.log("poolManager:", dep.v4.poolManager);
const poolId = "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b";
const refBlock = await c.getBlock({ blockNumber: BigInt(latestNum - 50) });
console.log("refBlock.timestamp:", refBlock.timestamp, typeof refBlock.timestamp);
const secPerBlock = Math.max(1, (Date.now() / 1000 - Number(refBlock.timestamp)) / 50);
const lookback = Math.min(Math.max(1, Math.ceil(900 / secPerBlock)), 7200);
console.log("secPerBlock:", secPerBlock.toFixed(1), "lookback blocks:", lookback);
const filter = { address: dep.v4.poolManager, topics: [TOPIC, poolId], fromBlock: BigInt(latestNum - lookback), toBlock: latest };
console.log("filter:", JSON.stringify({ ...filter, fromBlock: filter.fromBlock.toString(), toBlock: filter.toBlock.toString() }));
try {
  const logs = await c.getLogs(filter);
  console.log("OK logs:", logs.length);
} catch (e) { console.log("FAIL:", e.message.slice(0, 200)); }
