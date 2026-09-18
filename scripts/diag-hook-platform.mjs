/**
 * diag-hook-platform.mjs — identify the platform behind a V4 hook: scan the
 * hook's Initialize events to list every pool/pair it powers, and check
 * Dexscreener for a common profile (same launcher = same platform).
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

for (const line of readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
const { getChain } = await import("../chains.mjs");
const { createPublicClient, http, parseAbi, parseAbiItem } = await import("viem");
const dep = getChain("robinhood");
// Full-range getLogs needs the logs-capable endpoint (Alchemy free tier caps
// getLogs at 10 blocks) — same split the poolKey recovery uses.
const c = createPublicClient({ transport: http(dep.getLogsRpc?.() ?? dep.httpRpc()) });

// all V4 Initialize events on the chain's PoolManager, then filter to those
// whose poolKey includes our hook (topic-based filter: hooks is in the DATA,
// not topics, so pull data too). Full range works on the public RPC.
// all V4 Initialize events on the chain's PoolManager, then filter to those
// whose poolKey includes our hook (hooks live in the event DATA).
// Full-range getLogs works on the public RPC; Alchemy caps the range.
const INIT_EVT = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks)");
// Chunked full-range scan: the public RPC silently returns empty on huge
// unfiltered ranges. 2M-block windows keep each query bounded.
const head = await c.getBlockNumber();
const CHUNK = 2_000_000n;
const logs = [];
for (let start = 0n; start <= head; start += CHUNK) {
  const end = start + CHUNK - 1n > head ? head : start + CHUNK - 1n;
  const part = await c.getLogs({
    address: dep.v4.poolManager, event: INIT_EVT, fromBlock: start, toBlock: end,
  }).catch(() => []);
  logs.push(...part);
}

console.log(`total V4 pools initialized on ${dep.name}: ${logs.length}`);
const hooked = [];
for (const log of logs) {
  const hooks = log.args.hooks ?? "0x0000000000000000000000000000000000000000";
  if (hooks.toLowerCase() === HOOK.toLowerCase()) {
    hooked.push({
      id: log.args.id,
      fee: Number(log.args.fee),
      ts: Number(log.args.tickSpacing),
      c0: log.args.currency0,
      c1: log.args.currency1,
      block: Number(log.blockNumber),
    });
  }
}

console.log(`pools using hook ${HOOK.slice(0, 10)}…: ${hooked.length}`);
for (const p of hooked) {
  // identify which currency is the token (non-ETH, non-USDG)
  const ZERO = "0x0000000000000000000000000000000000000000";
  const usdg = dep.dollar.toLowerCase();
  const other = [p.c0, p.c1].find((a) => a !== ZERO && a.toLowerCase() !== usdg && a !== "0x0000000000000000000000000000000000000000");
  console.log(`  block ${p.block} | fee=${p.fee} ts=${p.ts} | ${p.c0 === ZERO ? "native ETH" : p.c0.slice(0, 12)} / ${p.c1.slice(0, 12)}`);
}

// now look up each token's symbol via Dexscreener
console.log("\n--- token identities on this hook ---");
for (const p of hooked) {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const other = [p.c0, p.c1].find((a) => a !== ZERO && a.toLowerCase() !== dep.dollar.toLowerCase());
  if (!other) continue;
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/${dep.dexscreener}/${other}`);
    const pairs = await res.json();
    const sym = pairs?.[0]?.baseToken?.symbol ?? "?";
    const liq = Math.max(...(pairs ?? []).map((x) => x.liquidity?.usd ?? 0));
    console.log(`  ${other} = ${sym} (liq $${Math.round(Math.max(...(pairs ?? []).map((x) => x.liquidity?.usd ?? 0)))})`);
  } catch { console.log(`  ${other}: lookup failed`); }
}
