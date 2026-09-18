/** Decode the V4 Swap event from the MESA sell to get the true proceeds. */
import { createPublicClient, http, decodeEventLog, parseAbi } from "viem";
const c = createPublicClient({ transport: http("https://robinhood-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMY_API_KEY) });
const TX = "0xce60473156498a3361647e867d927b8ff097b55b0b333eb78aaff40932751e4a";
const r = await c.getTransactionReceipt({ hash: TX });
for (const log of r.logs) {
  if (log.address.toLowerCase() !== "0x8366a39cc670b4001a1121b8f6a443a643e40951") continue;
  try {
    const ev = decodeEventLog({
      abi: parseAbi(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 protocolFee)"]),
      data: log.data, topics: log.topics,
    });
    const [a0, a1] = [ev.args.amount0, ev.args.amount1];
    // amount0/amount1: negative = pool PAID OUT that currency, positive = pool RECEIVED.
    // Sell MESA → pool receives MESA (negative from wallet's view? No: in V4 the
    // deltas are from the POOL's perspective: negative = pool balance decreased).
    console.log("V4 Swap event:", { amount0: a0.toString(), amount1: a1.toString() });
  } catch (e) { console.log("decode err:", String(e.message).slice(0, 120)); }
}
