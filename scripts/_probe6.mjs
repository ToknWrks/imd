// Isolate: which call throws "JSON is not a valid request object"?
import { httpClient, getChain } from "../chains.mjs";
import { getQuoteTokenDecimals } from "../mm-swap.mjs";
const c = httpClient("robinhood");
const dep = getChain("robinhood");
const latest = await c.getBlockNumber();
const latestNum = Number(latest);
const refBlock = await c.getBlock({ blockNumber: BigInt(latestNum - 50) });
console.log("1. block reads OK");

// quote decimals for a zero address (currency0 = ETH for SIRIUS)? The token side:
// SIRIUS pool: cur0=0x0 (ETH), cur1=token? tokenIs0 = (cur0==token) → false → quoteCurrency = cur0 = 0x0 → ETH → skip decimals
// But what about venue.poolKey.currency0 === ZERO and quoteIsEth false? Try reading decimals of zero address:
try {
  const d = await getQuoteTokenDecimals("0x0000000000000000000000000000000000000000", "robinhood");
  console.log("decimals(0x0) =", d);
} catch (e) { console.log("decimals(0x0) threw:", e.message.slice(0, 80)); }

// getLogs with topics[1] = zero-address? not used here.
// V3 branch: venue.address undefined for v4? no.
// Try getLogs with fromBlock > toBlock (lookback miscalc)?
try {
  const logs = await c.getLogs({ address: dep.v4.poolManager, topics: [ "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b" ], fromBlock: BigInt(latestNum - 900), toBlock: latest });
  console.log("getLogs OK:", logs.length);
} catch (e) { console.log("getLogs threw:", e.message.slice(0, 120)); }
