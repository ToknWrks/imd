/** Debug: verify Initialize topic hash + hook distribution. (read-only) */
import { RobinhoodProvider } from "../alpha-engine.mjs";
import { keccak256, toHex, createPublicClient, http } from "viem";
const RH_RPC = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const TOPIC_INIT = keccak256(toHex("Initialize(address,address,address,uint24,int24,address,bytes32)"));
console.log("Initialize topic:", TOPIC_INIT);

// 1) known-good: ATLANTIS Initialize verified at block 59513186 (chains.mjs)
const c = createPublicClient({ transport: http(RH_RPC) });
const ref = await c.getLogs({ address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", topics: [TOPIC_INIT], fromBlock: 59513185n, toBlock: 59513187n });
console.log("reference block 59513186 (ATLANTIS):", ref.length, "log(s)", ref.length ? "→ topic hash CORRECT" : "→ topic hash WRONG or range cap");

// 2) recent window via raw RPC (what the engine does)
const rh = new RobinhoodProvider({ rpcUrl: RH_RPC, initialLookback: 2000n });
const head = BigInt(await rh.rpc("eth_blockNumber"));
const from = head - 2000n;
try {
  // NOTE: toBlock "latest" returned 0 logs via raw RPC — explicit block number
  const logs = await rh.rpc("eth_getLogs", [{ address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", topics: [TOPIC_INIT], fromBlock: "0x" + from.toString(16), toBlock: "0x" + head.toString(16) }]);
  console.log("raw-RPC inits in last 2000 blocks (explicit toBlock):", logs.length);
  const hooks = new Map();
  for (const l of logs) {
    const words = String(l.data).slice(2).match(/.{64}/g) || [];
    const hook = ("0x" + (words[2]?.slice(24) || "")).toLowerCase();
    hooks.set(hook, (hooks.get(hook) || 0) + 1);
  }
  for (const [h, n] of [...hooks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log("  ", h, "x", n);
  const LH = "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544";
  console.log("LONG hook in window:", hooks.get(LH) ?? 0);
} catch (e) { console.log("raw RPC err:", String(e.message).slice(0, 120)); }
