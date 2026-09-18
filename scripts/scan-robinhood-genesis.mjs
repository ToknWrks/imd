/**
 * scan-robinhood-genesis.mjs — scan the first blocks of 4663 for V4 Initialize
 * events on the PoolManager to capture USDG poolKeys (fee/tickSpacing/hooks).
 * Read-only. Public RPC — small chunks, gentle pacing.
 */
import { createPublicClient, http, parseAbi } from "viem";
import { robinhood } from "./chain-robinhood.mjs";

const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168".toLowerCase();
const ETH0 = "0x0000000000000000000000000000000000000000";

const INIT_ABI = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);

// First: find the max getLogs range the public RPC tolerates
const head = await c.getBlockNumber();
console.log(`head: ${head}`);
let RANGE = 2048n;
try {
  await c.getLogs({ address: PM, fromBlock: head - RANGE, toBlock: head });
  console.log(`range ${RANGE} ok`);
} catch {
  RANGE = 512n;
  try {
    await c.getLogs({ address: PM, fromBlock: head - RANGE, toBlock: head });
    console.log(`range ${RANGE} ok`);
  } catch {
    RANGE = 128n;
    console.log(`falling back to range ${RANGE}`);
  }
}

const found = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let start = 1n; start < 3_000_000n && found.length < 20; start += RANGE) {
  const end = start + RANGE - 1n;
  let logs;
  try {
    logs = await c.getLogs({ address: PM, event: INIT_ABI[0], fromBlock: start, toBlock: end });
  } catch {
    await sleep(300);
    continue;
  }
  if (logs.length) {
    for (const log of logs) {
      const { id, currency0, currency1, fee, tickSpacing, hooks, tick } = log.args;
      const isUsdg = currency0?.toLowerCase() === USDG || currency1?.toLowerCase() === USDG;
      console.log(`init: id=${id.slice(0, 14)}… c0=${currency0.slice(0, 12)}… c1=${currency1.slice(0, 12)}… fee=${fee} ts=${tickSpacing} hooks=${hooks === ETH0 ? "none" : hooks.slice(0, 12)}…${isUsdg ? "  ← USDG" : ""}`);
      if (isUsdg) found.push({ id, currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks });
    }
  }
  if ((start / RANGE) % 50n === 0n) process.stdout.write(`…at block ${start}\n`);
  await sleep(120);
}
console.log(`\n${found.length} USDG pools in genesis→3M`);
