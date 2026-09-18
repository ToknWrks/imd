/**
 * map-robinhood-pools.mjs — full 4663 USDG V4 pool inventory with live
 * liquidity, via Alchemy (read-only). Also records WETH-denominated pools.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { robinhood } from "./chain-robinhood.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(resolve(__dirname, "../.env"), "utf8").split("\n")) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {}
const key = process.env.ALCHEMY_API_KEY?.trim();
if (!key) { console.error("ALCHEMY_API_KEY required"); process.exit(1); }
const RPC = `https://robinhood-mainnet.g.alchemy.com/v2/${key}`;
console.log("using Alchemy robinhood-mainnet");

const c = createPublicClient({ chain: robinhood, transport: http(RPC) });
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const SV = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168".toLowerCase();
const ETH0 = "0x0000000000000000000000000000000000000000";

const INIT_ABI = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
const SLOT0_ABI = parseAbi(["function getSlot0(bytes32) view returns (uint160,int24,uint16,uint16)"]);
const LIQ_ABI = parseAbi(["function getLiquidity(bytes32) view returns (uint128)"]);

// ── 1. Scan full chain history for USDG Initialize events ────────────────────
const head = await c.getBlockNumber();
console.log(`head: ${head}`);
const initLogs = [];
const CHUNK = 50_000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, 120));
for (let start = 1n; start < head && initLogs.length < 100; start += CHUNK) {
  let logs;
  try {
    logs = await c.getLogs({ address: PM, event: INIT_ABI[0], fromBlock: start, toBlock: start + CHUNK - 1n });
  } catch {
    await sleep(500);
    continue;
  }
  for (const log of logs) {
    const { id, currency0, currency1 } = log.args;
    if (currency0?.toLowerCase() === USDG || currency1?.toLowerCase() === currentUsdgLower()) continue;
    initLogs.push(log);
  }
}
function currentUsdgLower() { return USDG; }

// ── 2. Live liquidity per pool via StateView ─────────────────────────────────
const live = [];
for (const log of initLogs) {
  const { id, currency0, currency1, fee, tickSpacing, hooks } = log.args;
  try {
    const [sqrtPriceX96, tick] = await c.readContract({ address: SV, abi: SLOT0_ABI, functionName: "getSlot0", args: [id] });
    const liquidity = await c.readContract({ address: SV, abi: LIQ_ABI, functionName: "getLiquidity", args: [id] });
    live.push({ id, currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks, sqrtPriceX96, tick, liquidity });
  } catch { /* pool closed/never funded — skip */ }
}

// ─ pools with native ETH + USDG, ranked by depth ──
const ethUsdg = live.filter((p) => p.currency0 === ETH0 && p.currency1.toLowerCase() === USDG);
ethUsdg.sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1));
console.log(`\nETH/USDG pools (native ETH = currency0):`);
for (const p of ethUsdg.slice(0, 10)) {
  const s = Number(p.sqrtPriceX96) / 2 ** 96;
  const usdgPerEth = s * s * 10 ** 12; // 18 - 6 decimals
  console.log(`  ${p.id} fee=${p.fee} ts=${p.tickSpacing} liq=${p.liquidity} → ETH≈${usdgPerEth.toFixed(2)} USDG`);
}

// ── 3. WETH/USDG pools too ──
const weth = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73".toLowerCase();
const wethUsdg = live.filter((p) => p.currency1.toLowerCase() === USDG && p.currency0.toLowerCase() === weth);
console.log(`\nWETH/USDG pools:`);
for (const p of wethUsdg) console.log(`  ${p.id} fee=${p.fee} ts=${p.tickSpacing} liq=${p.liquidity}`);
