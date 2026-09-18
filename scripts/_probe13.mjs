// Run the watcher's getExternalFlow with a patch: log the exact failing step.
// Approach: temporarily instrument via a copy of the function inline — if the
// copy succeeds while the import fails, the difference is in module state.
import { getAnalysisClient, getChain } from "../chains.mjs";
import { resolveMmVenue, getMmSnapshot, getQuoteTokenDecimals } from "../mm-swap.mjs";
import { keccak256, toHex, getAddress } from "viem";

// IDENTICAL constants to mm-watcher.mjs
const SWAP_TOPIC_V4 = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const ETH_ADDRESS = "0x0000000000000000000000000000000000000000";

const chainKey = "robinhood";
const dep = getChain(chainKey);
const c = getAnalysisClient(chainKey);
const { venue, cls, meta } = await resolveMmVenue("0x3b4a0048a00787a644932cd648faa043410c163e", chainKey, null);
const snap = await getMmSnapshot(venue, cls, meta, chainKey);

const WINDOW_MS = 15 * 60_000;
const latest = await c.getBlockNumber();
const latestNum = Number(latest);
console.log("1 latest ok:", latestNum);
const refBlock = await c.getBlock({ blockNumber: BigInt(Math.max(1, latestNum - 50)) });
console.log("2 refBlock ok");
const secPerBlock = Math.max(1, (Number(refBlock.timestamp) ? (Date.now() / 1000 - Number(refBlock.timestamp)) / Math.min(50, latestNum - 1) : 2));
const lookbackBlocks = Math.min(Math.max(1, Math.ceil(WINDOW_MS / 1000 / secPerBlock)), 7200);
console.log("3 lookback:", lookbackBlocks);

const tokenLower = getAddress("0x3b4a0048a00787a644932cd648faa043410c163e").toLowerCase();
const tokenIs0 = getAddress(venue.poolKey.currency0).toLowerCase() === tokenLower;
const quoteCurrency = tokenIs0 ? venue.poolKey.currency1 : venue.poolKey.currency0;
const quoteIsEth = getAddress(quoteCurrency).toLowerCase() === ETH_ADDRESS;
const quoteDec = quoteIsEth ? 18 : await getQuoteTokenDecimals(quoteCurrency, chainKey);
console.log("4 quoteDec ok:", quoteDec, "tokenIs0:", tokenIs0);

const filter = { address: dep.v4.poolManager, topics: [SWAP_TOPIC_V4, venue.poolId], fromBlock: BigInt(latestNum - lookbackBlocks), toBlock: latest };
console.log("5 filter built; toBlock:", filter.toBlock.toString(), "fromBlock:", filter.fromBlock.toString());
console.log("   topics[1] type:", typeof filter.topics[1], "len:", filter.topics[1]?.length);
const logs = await c.getLogs(filter);
console.log("6 getLogs OK:", logs.length);
process.exit(0);
