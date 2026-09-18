/** Which endpoint returns recent PoolManager logs, and at what range size? */
import { RobinhoodProvider } from "../alpha-engine.mjs";
import { keccak256, toHex, createPublicClient, http } from "viem";
const RH_RPC = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const TOPIC_INIT = keccak256(toHex("Initialize(address,address,address,uint24,int24,address,bytes32)"));
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const rh = new RobinhoodProvider({ rpcUrl: RH_RPC });
const head = BigInt(await rh.rpc("eth_blockNumber"));

// Test progressively smaller ranges on the raw public RPC
for (const range of [2000n, 1000n, 100n, 10n]) {
  try {
    const logs = await rh.rpc("eth_getLogs", [{ address: PM, topics: [TOPIC_INIT], fromBlock: "0x" + (head - range).toString(16), toBlock: "0x" + head.toString(16) }]);
    console.log(`raw public RPC, ${range}-block range:`, logs.length, "logs");
  } catch (e) { console.log(`raw ${range}-block: ERR`, String(e.message).slice(0, 90)); }
}

// Same range via viem client (worked for the reference block)
const c = createPublicClient({ transport: http(RH_RPC) });
for (const range of [2000n, 100n]) {
  try {
    const logs = await c.getLogs({ address: PM, topics: [TOPIC_INIT], fromBlock: head - range, toBlock: head });
    console.log(`viem client, ${range}-block range:`, logs.length, "logs");
  } catch (e) { console.log(`viem ${range}-block: ERR`, String(e.message).slice(0, 90)); }
}

// Alchemy with 10-block steps (known cap) — does it find LONG inits at all?
const key = process.env.ALCHEMY_API_KEY;
if (key) {
  const a = createPublicClient({ transport: http(`https://robinhood-mainnet.g.alchemy.com/v2/${key}`) });
  let longs = 0, total = 0;
  for (let s = head - 500n; s < head; s += 10n) {
    try {
      const logs = await a.getLogs({ address: PM, topics: [TOPIC_INIT], fromBlock: s, toBlock: s + 9n });
      for (const l of logs) {
        const words = String(l.data).slice(2).match(/.{64}/g) || [];
        if (("0x" + (words[2]?.slice(24) || "")).toLowerCase() === "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544") longs++;
      }
      total++;
    } catch {}
  }
  console.log("alchemy 500 blocks in 10-block steps:", longs, "LONG inits");
}
