// Minimal repro WITHOUT importing mm-watcher: run getExternalFlow's exact
// sequence on the unbatched analysis client while another import also uses
// viem concurrently — to see if the failure is a viem-internal issue with
// large getLogs when two clients share a process, or the batch transport.
import { getAnalysisClient } from "../chains.mjs";
import { keccak256, toHex } from "viem";
const c = getAnalysisClient("robinhood");
const TOPIC = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const latest = await c.getBlockNumber();
const latestNum = Number(latest);
const refBlock = await c.getBlock({ blockNumber: BigInt(latestNum - 50) });
const secPerBlock = Math.max(1, (Date.now() / 1000 - Number(refBlock.timestamp)) / 50);
const lookback = Math.min(Math.max(1, Math.ceil(900 / secPerBlock)), 7200);
console.log("lookback:", lookback);
// 4 concurrent getLogs like the watcher tick would issue sequentially per strategy
const POOLS = [
  "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b",
  "0xac3ed4bca6a091c1b2d64b5f3aaf0f5f1d7be6c27f8b0d3c96cf642f4b0e3e7d",
  "0xe2d124b5b0b7b6be8ba7ec1c3d1b0a5e0d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a",
  "0xa53e1fc0040404040404040404040404040404040404040404040404040404",
];
const results = await Promise.allSettled(POOLS.map((p) =>
  c.getLogs({ address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", topics: [TOPIC, p], fromBlock: BigInt(latestNum - lookback), toBlock: latest })));
results.forEach((r, i) => console.log(`pool${i}:`, r.status, r.status === "fulfilled" ? r.value.length + " logs" : String(r.reason).slice(0, 80)));
process.exit(0);
