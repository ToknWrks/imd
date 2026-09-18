/**
 * poolkey-from-init.mjs — recover a V4 poolKey from its Initialize event.
 * One topic-filtered getLogs over a block window; falls back to chunked scan.
 * Usage: node scripts/poolkey-from-init.mjs <poolId> [fromBlock] [toBlock]
 */
import { createPublicClient, http, parseAbi } from "viem";
import { robinhood } from "./chain-robinhood.mjs";

const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const ETH0 = "0x0000000000000000000000000000000000000000";

const INIT_ABI = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);

const poolId = process.argv[2];
if (!poolId || poolId.length !== 66) { console.error("usage: node poolkey-from-init.mjs <poolId>"); process.exit(1); }

const head = await c.getBlockNumber();
const to = BigInt(process.argv[4] ?? head);
const from = BigInt(process.argv[3] ?? 1n);

const sleep = (ms) => new Promise((r) => setTimeout(r, 250));
const CHUNK = 2048n;
for (let start = from; start < to; start += CHUNK) {
  const end = start + CHUNK - 1n > to ? to : start + CHUNK - 1n;
  let logs;
  try {
    logs = await c.getLogs({
      address: PM,
      event: INIT_ABI[0],
      args: { id: poolId },
      fromBlock: start,
      toBlock: end,
    });
  } catch {
    await sleep(200);
    continue;
  }
  if (logs.length) {
    const { id, currency0, currency1, fee, tickSpacing, hooks, sqrtPriceX96, tick } = logs[0].args;
    console.log(JSON.stringify({
      poolId: id,
      currency0, currency1,
      fee: Number(fee), tickSpacing: Number(tickSpacing), hooks,
      sqrtPriceX96: sqrtPriceX96.toString(), tick: Number(tick),
    }, null, 2));
    process.exit(0);
  }
}
console.log("not found in range");
process.exit(1);
