#!/usr/bin/env node
// find-token-pool.mjs — find a token's Uniswap V4 pool by scanning the
// PoolManager's Initialize events, chunked backward from the chain head.
// Read-only, no funds move, no signer needed.
//
// Needed on chains Dexscreener doesn't index (e.g. Robinhood) or for hooked /
// non-standard-fee pools that dip-swap.mjs's poolKey brute-force can't guess —
// Initialize logs carry the exact currency0/currency1/fee/tickSpacing/hooks,
// no guessing required. Scans backward from the chain head since a token's
// pool is almost always newer than most of the chain's history.
//
// Usage: node scripts/find-token-pool.mjs <tokenAddress> [chainKey] [maxBlocksBack]
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {}

const { createPublicClient, http, parseAbi, getAddress } = await import("viem");
const { getChain } = await import("../chains.mjs");

const tokenArg = process.argv[2];
if (!tokenArg) {
  console.error("usage: node scripts/find-token-pool.mjs <tokenAddress> [chainKey] [maxBlocksBack]");
  process.exit(1);
}
const TOKEN = getAddress(tokenArg);
const CHAIN_KEY = process.argv[3] ?? "ethereum";
const MAX_BLOCKS_BACK = BigInt(process.argv[4] ?? 2_000_000);
const dep = getChain(CHAIN_KEY);

// chains.mjs's httpRpc() doesn't route Robinhood through Alchemy yet even
// when a key is configured (see CLAUDE.md) — build the Alchemy URL directly
// here, same pattern as scripts/find-robinhood-poolkey.mjs, and fall back to
// the chain's default RPC if Alchemy isn't reachable for this chain.
const ALCHEMY_SUBDOMAIN = { ethereum: "eth-mainnet", robinhood: "robinhood-mainnet", base: "base-mainnet" };
const alchemyKey = process.env.ALCHEMY_API_KEY?.trim();

async function buildClient() {
  if (alchemyKey && ALCHEMY_SUBDOMAIN[CHAIN_KEY]) {
    const url = `https://${ALCHEMY_SUBDOMAIN[CHAIN_KEY]}.g.alchemy.com/v2/${alchemyKey}`;
    const candidate = createPublicClient({ chain: dep.viemChain, transport: http(url) });
    try {
      // getBlockNumber can succeed even when eth_getLogs itself is rejected
      // for this network (verified: robinhood-mainnet does exactly this) —
      // the real check has to be a getLogs call, not just liveness.
      const head = await candidate.getBlockNumber();
      await candidate.getLogs({ address: dep.v4.poolManager, fromBlock: head - 10n, toBlock: head });
      console.log(`using Alchemy ${ALCHEMY_SUBDOMAIN[CHAIN_KEY]}`);
      return { client: candidate, chunk: 50_000n };
    } catch (e) {
      console.log(`Alchemy getLogs unavailable for ${CHAIN_KEY} (${e.shortMessage ?? e.message}) — falling back to public RPC`);
    }
  }
  return { client: createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc()) }), chunk: 2_000n };
}

const { client: c, chunk: CHUNK } = await buildClient();

const INIT_ABI = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);

const head = await c.getBlockNumber();
const lowerBound = head > MAX_BLOCKS_BACK ? head - MAX_BLOCKS_BACK : 0n;
console.log(`${dep.name}: head block ${head}, scanning backward to ${lowerBound} in chunks of ${CHUNK}`);

const found = [];
const skippedRanges = []; // chunks that failed every retry — result may be incomplete over these
let chunkNum = 0;
for (let end = head; end > lowerBound; end -= CHUNK) {
  const start = end - CHUNK + 1n > lowerBound ? end - CHUNK + 1n : lowerBound;
  chunkNum++;
  let logsA, logsB, ok = false;
  for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
    try {
      [logsA, logsB] = await Promise.all([
        c.getLogs({ address: dep.v4.poolManager, event: INIT_ABI[0], args: { currency1: TOKEN }, fromBlock: start, toBlock: end }),
        c.getLogs({ address: dep.v4.poolManager, event: INIT_ABI[0], args: { currency0: TOKEN }, fromBlock: start, toBlock: end }),
      ]);
      ok = true;
    } catch (e) {
      if (attempt === 4) {
        console.log(`  chunk ${chunkNum} (${start}-${end}) failed after 4 attempts: ${e.shortMessage ?? e.message} — gap left in results`);
        skippedRanges.push([start, end]);
      } else {
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
  }
  if (!ok) continue; // this chunk's range is a known gap — do not abort the whole scan over one bad chunk
  for (const log of [...logsA, ...logsB]) {
    const { id, currency0, currency1, fee, tickSpacing, hooks } = log.args;
    found.push({ id, currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks, block: log.blockNumber });
  }
  // Keep scanning the full range even after a hit — a token can have several
  // pools (different quote currency, different fee tier) and the one our
  // ETH-based buyDip() needs is specifically the ETH-paired one, which isn't
  // necessarily the newest.
  if (chunkNum % 20 === 0) console.log(`  …scanned to block ${start}, ${found.length} pool(s) so far`);
  await new Promise((r) => setTimeout(r, 100));
}
if (skippedRanges.length) {
  console.log(`\nWARNING: ${skippedRanges.length} block range(s) could not be scanned after retries — results may be missing pools in: ${skippedRanges.map(([s, e]) => `${s}-${e}`).join(", ")}`);
  console.log(`Re-run the same command if you want another pass at closing these gaps.`);
}

if (!found.length) {
  console.log(`\nno Initialize event found for ${TOKEN} within ${MAX_BLOCKS_BACK} blocks of head${skippedRanges.length ? " (and some ranges couldn't be scanned — see WARNING above)" : ""}.`);
  console.log(`Try a larger maxBlocksBack (4th arg), or the token has no Uniswap V4 pool on ${dep.name}.`);
  process.exit(1);
}

const ETH0 = "0x0000000000000000000000000000000000000000";
const isEthPaired = (p) => p.currency0.toLowerCase() === ETH0 || p.currency1.toLowerCase() === ETH0;
const ethPools = found.filter(isEthPaired).sort((a, b) => Number(a.block - b.block));
const otherPools = found.filter((p) => !isEthPaired(p)).sort((a, b) => Number(a.block - b.block));

if (!ethPools.length) {
  console.log(`\nNo ETH-paired pool found among ${found.length} pool(s) for this token — buyDip() swaps native ETH in, so it needs a pool where one side is 0x000...000.`);
  console.log(`This token may only trade against another token (e.g. USDG) here; buying with ETH would need routing through that pool, which isn't currently supported.`);
  process.exit(1);
}

const canonical = ethPools[0]; // oldest ETH-paired pool — matches the launch/bonding-curve pool actually used in real swaps
console.log(`\nfound ${found.length} pool(s) total (${ethPools.length} ETH-paired, ${otherPools.length} other-quote).`);
if (skippedRanges.some(([s]) => s < canonical.block)) {
  console.log(`NOTE: some older block ranges than this pool's Initialize block couldn't be scanned — an even older ETH-paired pool may exist. Re-run to close the gap if this pool doesn't work.`);
}
if (ethPools.length > 1) {
  console.log(`Multiple ETH-paired pools exist — a launcher platform (e.g. Pons) can spawn many pools per token, most unused.`);
  console.log(`Defaulting to the OLDEST ETH-paired pool as canonical (matches the actual swap tx you gave me earlier):`);
}
console.log(`\n  poolId: ${canonical.id}  ← use this`);
console.log(`    currency0=${canonical.currency0} currency1=${canonical.currency1} fee=${canonical.fee} tickSpacing=${canonical.tickSpacing} hooks=${canonical.hooks === ETH0 ? "none" : canonical.hooks} block=${canonical.block}`);

if (ethPools.length > 1) {
  console.log(`\nOther ETH-paired pools found (newer, likely unused — verify before trusting):`);
  for (const p of ethPools.slice(1)) {
    console.log(`  poolId: ${p.id} fee=${p.fee} tickSpacing=${p.tickSpacing} hooks=${p.hooks === ETH0 ? "none" : p.hooks} block=${p.block}`);
  }
}
console.log(`\nPaste the poolId marked "use this" into the token's "Pool override" field on the dashboard (Edit).`);
