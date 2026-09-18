import { httpClient } from "../chains.mjs";
const c = httpClient("robinhood");
const latest = await c.getBlockNumber();
// SIRIUS venue object shape from resolveMmVenue → findBestV4Pool
const { resolveMmVenue } = await import("../mm-swap.mjs");
const { venue } = await resolveMmVenue("0x3b4a0048a00787a644932cd648faa043410c163e", "robinhood", null);
console.log("venue.kind:", venue.kind, "poolId type:", typeof venue.poolId, venue.poolId?.slice(0, 14));
console.log("poolId length:", venue.poolId?.length);
const SWAP_TOPIC_V4 = "0x40e9cecb9f5f1f1c5b6c6d055b0a5f0e572aa850f2011d6e6d2f9e1c1bd0f31e";
// use the real topic computed the same way as the watcher
const { keccak256, toHex } = await import("viem");
const TOPIC = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
try {
  const logs = await c.getLogs({ address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", topics: [TOPIC, venue.poolId], fromBlock: latest - 100n, toBlock: latest });
  console.log("getLogs OK, logs:", logs.length);
  if (logs.length) {
    const d = logs[0].data.slice(2);
    const a0 = BigInt("0x" + d.slice(0, 64));
    const a1 = BigInt("0x" + d.slice(64, 128));
    console.log("a0:", a0.toString().slice(0, 30), "a1:", a1.toString().slice(0, 20));
  }
} catch (e) { console.log("FAIL:", e.message.slice(0, 150)); }
