// Isolate the exact failing call inside the watcher's getExternalFlow by
// monkey-patching console to add try/catch granularity — actually simpler:
// replicate the function line by line with granular logging.
import { httpClient, getChain } from "../chains.mjs";
import { resolveMmVenue, getMmSnapshot, getQuoteTokenDecimals } from "../mm-swap.mjs";
import { keccak256, toHex, getAddress } from "viem";

const SWAP_TOPIC_V4 = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const ETH_ADDRESS = "0x0000000000000000000000000000000000000000";

const dep = getChain("robinhood");
const c = httpClient("robinhood");
const { venue, cls, meta } = await resolveMmVenue("0x3b4a0048a00787a644932cd648faa043410c163e", "robinhood", null);
const snap = await getMmSnapshot(venue, cls, meta, "robinhood");
console.log("venue.kind:", venue.kind);

const WINDOW_MS = 15 * 60_000;
const latest = await c.getBlockNumber();
const latestNum = Number(latest);
const refBlock = await c.getBlock({ blockNumber: BigInt(Math.max(1, latestNum - 50)) });
const secPerBlock = Math.max(1, (Number(refBlock.timestamp) ? (Date.now() / 1000 - Number(refBlock.timestamp)) / Math.min(50, latestNum - 1) : 2));
const lookbackBlocks = Math.min(Math.max(1, Math.ceil(WINDOW_MS / 1000 / secPerBlock)), 7200);
console.log("lookbackBlocks:", lookbackBlocks);

const tokenLower = getAddress("0x3b4a0048a00787a644932cd648faa043410c163e").toLowerCase();
const tokenIs0 = getAddress(venue.poolKey.currency0).toLowerCase() === tokenLower;
console.log("tokenIs0:", tokenIs0, "cur0:", venue.poolKey.currency0.slice(0, 10), "cur1:", venue.poolKey.currency1?.slice?.(0, 10));
const quoteCurrency = tokenIs0 ? venue.poolKey.currency1 : venue.poolKey.currency0;
console.log("quoteCurrency:", quoteCurrency, typeof quoteCurrency, quoteCurrency?.length);
const quoteIsEth = getAddress(quoteCurrency).toLowerCase() === ETH_ADDRESS;
console.log("quoteIsEth:", quoteIsEth);
const quoteDec = quoteIsEth ? 18 : await getQuoteTokenDecimals(quoteCurrency, "robinhood");
console.log("quoteDec:", quoteDec);

const isV4 = venue.kind !== "v3";
const filter = isV4
  ? { address: dep.v4.poolManager, topics: [SWAP_TOPIC_V4, venue.poolId], fromBlock: BigInt(latestNum - lookbackBlocks), toBlock: latest }
  : { address: venue.address, topics: [SWAP_TOPIC_V3], fromBlock: BigInt(latestNum - lookbackBlocks), toBlock: latest };
console.log("filter toBlock type:", typeof filter.toBlock, filter.toBlock.toString?.());
const logs = await c.getLogs(filter);
console.log("logs:", logs.length);
