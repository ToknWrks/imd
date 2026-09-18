// Decode a REAL V4 Swap log from the SIRIUS pool to get the data layout right.
import { getLogsClient } from "../chains.mjs";
import { keccak256, toHex } from "viem";
const c = getLogsClient("robinhood");
const TOPIC = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const latest = await c.getBlockNumber();
const logs = await c.getLogs({
  address: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  topics: [TOPIC, "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b"],
  fromBlock: latest - 5n, toBlock: latest,
});
console.log("logs:", logs.length);
const L = logs[logs.length - 1];
console.log("full log:", JSON.stringify(L, (k, v) => typeof v === "bigint" ? v.toString() : v, 2).slice(0, 1200));
const d = L.data.slice(2);
console.log("data words:");
for (let i = 0; i < d.length / 64; i++) {
  const w = d.slice(i * 64, (i + 1) * 64);
  const asUint = BigInt("0x" + w);
  // interpret as signed: if >= 2^255, negative
  const neg = asUint >= (1n << 255n);
  console.log(`  word${i}: hex=${w.slice(0, 20)}… uint=${asUint.toString().slice(0, 30)} ${neg ? "NEG int=" + -( (1n << 256n) - asUint).toString().slice(0,30) : ""}`);
}
process.exit(0);
