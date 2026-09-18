#!/usr/bin/env node
// verify-base.mjs — one-shot live verification of the Base (8453) Uniswap V4/V3
// stack + WETH/USDC/Chainlink candidates, before trusting any of them in
// chains.mjs. Read-only: eth_call / eth_getCode only. No signer, no funds move.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { mainnet, base } from "viem/chains";

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {}

const KEY = process.env.ALCHEMY_API_KEY?.trim();
const BASE_RPC = KEY ? `https://base-mainnet.g.alchemy.com/v2/${KEY}` : "https://mainnet.base.org";
const MAINNET_RPC = KEY ? `https://eth-mainnet.g.alchemy.com/v2/${KEY}` : "https://ethereum-rpc.publicnode.com";

const baseClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });
const mainnetClient = createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC) });

// V4 candidates from developers.uniswap.org/contracts/v4/deployments (Base is
// NOT canonical-address — confirmed below, first attempt against mainnet's
// addresses came back empty). V3/periphery ARE at mainnet's canonical
// addresses on Base (confirmed below).
const V4_POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const V4_QUOTER = "0x0d5e0F971ED27FBfF6c2837bf31316121532048D";
const V4_STATE_VIEW = "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71";
const UNIVERSAL_ROUTER_CANONICAL = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af"; // mainnet address; has bytecode on Base too, verify functionally
const UNIVERSAL_ROUTER = "0x6fF5693b99212Da76ad316178A184AB56D299b43"; // per Uniswap's Base deployment list
// V3 on Base is NOT at mainnet's canonical addresses either (confirmed below —
// first attempt against mainnet's factory address returned no data). These
// are Base's own periphery addresses per developers.uniswap.org.
const V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const V3_QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const V3_SWAP_ROUTER02 = "0x2626664c2603336E57B271c5C0b26F421741e481";
const V2_FACTORY = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"; // not in the live trading path (findBestV2Pair is unused), verified for completeness only
const WETH_CANDIDATE = "0x4200000000000000000000000000000000000006"; // OP-stack predeploy
const USDC_CANDIDATE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // native USDC on Base
const CHAINLINK_ETH_USD_CANDIDATE = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70"; // candidate, unverified

const ERC20_ABI = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const FACTORY_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const POOL_ABI = parseAbi(["function liquidity() view returns (uint128)"]);
const CHAINLINK_ABI = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
const STATE_VIEW_ABI = parseAbi(["function getSlot0(bytes32) view returns (uint160,int24,uint16,uint16)"]);

let failures = 0;
function ok(label, detail) { console.log(`   ✓ ${label}${detail ? " — " + detail : ""}`); }
function bad(label, detail) { console.log(`   ✗ ${label}${detail ? " — " + detail : ""}`); failures++; }

console.log("1) V4 StateView against REAL live Base pools (from Dexscreener) — decisive functional proof");
// PoolManager.owner() reverts with empty data on Base (likely a different
// Ownable convention/version than mainnet's PoolManager) — not a reliable
// signal either way. What actually matters is whether StateView on Base
// returns real, plausible pricing for real V4 pools, so that's what we check.
try {
  const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/base/${USDC_CANDIDATE}`);
  const pairs = await res.json();
  const v4 = (pairs ?? []).filter((p) => p.dexId === "uniswap" && (p.labels ?? []).includes("v4"));
  if (!v4.length) throw new Error("no live V4 pools found via Dexscreener to test against");
  let verified = 0;
  for (const p of v4.slice(0, 3)) {
    const poolId = p.pairAddress;
    const [sqrtPriceX96, tick] = await baseClient.readContract({ address: V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] });
    if (sqrtPriceX96 > 0n) { verified++; console.log(`     ${poolId.slice(0, 14)}… (${p.baseToken?.symbol}/${p.quoteToken?.symbol}) tick=${tick} sqrtPriceX96=${sqrtPriceX96}`); }
  }
  if (verified > 0) ok("StateView", `${verified}/${v4.slice(0, 3).length} real Base V4 pools returned live, plausible slot0 data`);
  else bad("StateView", "no real pool returned a nonzero price");
} catch (e) { bad("StateView", e.message); }

console.log("2) V4 PoolManager / Quoter / Universal Router bytecode present");
for (const [label, addr] of [["PoolManager", V4_POOL_MANAGER], ["Quoter", V4_QUOTER], ["UniversalRouter (Base list)", UNIVERSAL_ROUTER], ["UniversalRouter (mainnet addr, informational)", UNIVERSAL_ROUTER_CANONICAL]]) {
  try {
    const code = await baseClient.getCode({ address: addr });
    if (code && code !== "0x") ok(label, `${code.length} bytes of code`);
    else bad(label, "no bytecode at this address on Base");
  } catch (e) { bad(label, e.message); }
}

console.log("3) WETH candidate symbol/decimals");
try {
  const [symbol, decimals] = await Promise.all([
    baseClient.readContract({ address: WETH_CANDIDATE, abi: ERC20_ABI, functionName: "symbol" }),
    baseClient.readContract({ address: WETH_CANDIDATE, abi: ERC20_ABI, functionName: "decimals" }),
  ]);
  if (symbol === "WETH" && decimals === 18) ok("WETH", `${WETH_CANDIDATE} symbol=${symbol} decimals=${decimals}`);
  else bad("WETH", `${WETH_CANDIDATE} symbol=${symbol} decimals=${decimals} (unexpected)`);
} catch (e) { bad("WETH", e.message); }

console.log("4) USDC candidate symbol/decimals (watch for squatters)");
try {
  const [symbol, decimals] = await Promise.all([
    baseClient.readContract({ address: USDC_CANDIDATE, abi: ERC20_ABI, functionName: "symbol" }),
    baseClient.readContract({ address: USDC_CANDIDATE, abi: ERC20_ABI, functionName: "decimals" }),
  ]);
  if (symbol === "USDC" && decimals === 6) ok("USDC", `${USDC_CANDIDATE} symbol=${symbol} decimals=${decimals}`);
  else bad("USDC", `${USDC_CANDIDATE} symbol=${symbol} decimals=${decimals} (unexpected)`);
} catch (e) { bad("USDC", e.message); }

console.log("5) V3 factory.getPool(WETH,USDC,500) — must return a real pool with liquidity");
try {
  const pool = await baseClient.readContract({ address: V3_FACTORY, abi: FACTORY_ABI, functionName: "getPool", args: [WETH_CANDIDATE, USDC_CANDIDATE, 500] });
  if (!pool || pool === "0x0000000000000000000000000000000000000000") { bad("V3 factory", "no pool returned for WETH/USDC @500"); }
  else {
    const liq = await baseClient.readContract({ address: pool, abi: POOL_ABI, functionName: "liquidity" });
    if (liq > 0n) ok("V3 factory + WETH/USDC pool", `${pool} liquidity=${liq}`);
    else bad("V3 factory", `pool ${pool} found but liquidity=0`);
  }
} catch (e) { bad("V3 factory", e.message); }

console.log("6) V3 QuoterV2 / SwapRouter02 / V2 Factory bytecode present");
for (const [label, addr] of [["QuoterV2", V3_QUOTER_V2], ["SwapRouter02", V3_SWAP_ROUTER02], ["V2 Factory", V2_FACTORY]]) {
  try {
    const code = await baseClient.getCode({ address: addr });
    if (code && code !== "0x") ok(label, `${code.length} bytes of code`);
    else bad(label, "no bytecode at this address on Base");
  } catch (e) { bad(label, e.message); }
}

console.log("7) Chainlink ETH/USD feed candidate — latestRoundData sanity check");
try {
  const [, answer, , updatedAt] = await baseClient.readContract({ address: CHAINLINK_ETH_USD_CANDIDATE, abi: CHAINLINK_ABI, functionName: "latestRoundData" });
  const price = Number(answer) / 1e8;
  const ageSec = Date.now() / 1000 - Number(updatedAt);
  if (price > 100 && price < 100000) ok("Chainlink ETH/USD", `$${price.toFixed(2)} (updated ${Math.round(ageSec)}s ago)`);
  else bad("Chainlink ETH/USD", `implausible price $${price} — do not trust this feed address`);
} catch (e) { bad("Chainlink ETH/USD", e.message); }

console.log("8) Dexscreener network id \"base\" — real token lookup");
try {
  const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/base/${USDC_CANDIDATE}`);
  const pairs = await res.json();
  const hasV3 = (pairs ?? []).some((p) => p.dexId === "uniswap" && (p.labels ?? []).includes("v3"));
  const hasV4 = (pairs ?? []).some((p) => p.dexId === "uniswap" && (p.labels ?? []).includes("v4"));
  if (Array.isArray(pairs) && pairs.length) ok("Dexscreener \"base\"", `${pairs.length} pairs, v3=${hasV3}, v4=${hasV4}`);
  else bad("Dexscreener \"base\"", "no pairs returned");
} catch (e) { bad("Dexscreener \"base\"", e.message); }

console.log(failures ? `\n${failures} check(s) FAILED — do not trust the failing addresses in chains.mjs without further investigation.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
