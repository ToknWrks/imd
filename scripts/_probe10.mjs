// Why 0 logs here but 6871 via getLogs()? Probably block range drift (the
// earlier probe ran ~40 min ago). Just re-run the SAME getLogs filter shape
// the watcher uses, freshly:
import { httpClient } from "../chains.mjs";
const c = httpClient("robinhood");
const latest = await c.getBlockNumber();
const res = await c.getLogs({
  address: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  topics: ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b"],
  fromBlock: latest - 900n,
  toBlock: latest,
});
console.log("fresh getLogs:", res.length, "logs; latest =", latest.toString());
if (res.length) {
  const d = res[res.length - 1].data.slice(2);
  const a0 = BigInt("0x" + d.slice(0, 64));
  const a1 = BigInt("0x" + d.slice(64, 128));
  console.log("last log a0 sign:", a0 < 0n ? "neg" : "pos", "a1 sign:", a1 < 0n ? "neg" : "pos");
  console.log("last log a0:", a0.toString().slice(0, 40), "a1:", a1.toString().slice(0, 40));
}
process.exit(0);
