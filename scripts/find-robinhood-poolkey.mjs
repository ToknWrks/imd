/**
 * find-robinhood-poolkey.mjs — find ETH/USDG V4 poolKeys on 4663 by reading
 * the PoolManager's Initialize events (read-only, no signer, no funds).
 * Uses the user's Alchemy key (serves robinhood-mainnet) when available.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createPublicClient, http, parseAbi } from "viem";
import { robinhood } from "./chain-robinhood.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(resolve(__dirname, "../.env"), "utf8").split("\n")) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {}

const key = process.env.ALCHEMY_API_KEY?.trim();
const RPC = key ? `https://robinhood-mainnet.g.alchemy.com/v2/${key}` : "https://rpc.mainnet.chain.robinhood.com";
console.log(`using RPC: ${key ? RPC.replace(key, "***") : RPC}`);

const c = createPublicClient({ chain: robinhood, transport: http(RPC) });
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168".toLowerCase();
const ETH0 = "0x0000000000000000000000000000000000000000";

const INIT_ABI = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);

const head = await c.getBlockNumber();
console.log(`head block: ${head}`);
const found = new Map();
const CHUNK = 2000n;
let failures = 0;
for (let end = head; end > head - 400_000n && failures < 5; end -= CHUNK) {
  const start = end - CHUNK + 1n;
  let logs;
  try {
    logs = await c.getLogs({ address: PM, event: INIT_ABI[0], fromBlock: start, toBlock: end });
  } catch {
    failures++;
    continue;
  }
  for (const log of logs) {
    const { id, currency0, currency1, fee, tickSpacing, hooks, tick } = log.args;
    if (currency0?.toLowerCase() === USDG || currency1?.toLowerCase() === USDG) {
      found.set(id.toLowerCase(), {
        id, currency0, currency1,
        fee: Number(fee), tickSpacing: Number(tickSpacing),
        hooked: hooks !== ETH0, tick: Number(tick),
      });
    }
  }
}
console.log(`\n${found.size} USDG pools found:`);
for (const [id, p] of found) {
  const nativeEth = p.currency0.toLowerCase() === ETH0;
  console.log(
    `  id=${id.slice(0, 14)}… nativeETH=${nativeEth} other=${(nativeEth ? p.currency1 : p.currency0).slice(0, 12)}…` +
    ` fee=${p.fee} ts=${p.tickSpacing} hooked=${p.hooked} tick=${p.tick}`
  );
}
