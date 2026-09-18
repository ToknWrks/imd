/**
 * verify-robinhood.mjs — one-shot verification of the 4663 Uniswap V4 stack.
 * Read-only: eth_call / simulateContract only. No signer, no funds move.
 */
import { createPublicClient, http, parseAbi, keccak256, encodeAbiParameters, parseAbiParameters, formatUnits, defineChain } from "viem";

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
});

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const c = createPublicClient({ chain: robinhood, transport: http(RPC) });

// Verified sources: UniswapX playbook + o1exchange docs (owner() matched canonical).
const V4_STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const V4_QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const ETH0 = "0x0000000000000000000000000000000000000000";

const TARGET_POOL_ID = "0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551"; // Dexscreener's largest ETH/USDG V4 pool

console.log("1) Brute-force the ETH/USDG poolKey…");
let poolKey = null;
outer: for (const fee of [100, 500, 3000, 10000, 1, 25, 2500]) {
  for (const ts of [1, 2, 4, 5, 10, 20, 50, 60, 100, 200, 400, 800]) {
    const key = { currency0: ETH0, currency1: USDG, fee, tickSpacing: ts, hooks: ETH0 };
    const id = keccak256(encodeAbiParameters(
      parseAbiParameters("address,address,uint24,int24,address"),
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ));
    if (id.toLowerCase() === TARGET_POOL_ID) { poolKey = key; break outer; }
  }
}
if (!poolKey) { console.error("poolKey NOT found — pool is hooked or non-standard"); process.exit(1); }
console.log("   ✓ poolKey:", JSON.stringify(poolKey));

console.log("2) Spot price from StateView.getSlot0…");
const [sqrtPriceX96, tick] = await c.readContract({
  address: V4_STATE_VIEW,
  abi: parseAbi(["function getSlot0(bytes32) view returns (uint160,int24,uint16,uint16)"]),
  functionName: "getSlot0",
  args: [poolKey ? getPoolId(poolKey) : TARGET_POOL_ID],
});
const s = Number(sqrtPriceX96) / 2 ** 96;
const usdgPerEth = s * s * 10 ** (18 - 6); // USDG has 6 decimals
console.log(`   ✓ ETH = ${usdgPerEth.toFixed(2)} USDG (tick ${tick})`);

console.log("3) Quote 0.05 ETH → USDG via the V4 Quoter…");
const { result } = await c.simulateContract({
  address: V4_QUOTER,
  abi: parseAbi(["function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)"]),
  functionName: "quoteExactInputSingle",
  args: [{ poolKey, zeroForOne: true, exactAmount: 50000000000000000n, hookData: "0x" }],
});
console.log(`   ✓ 0.05 ETH → ${formatUnits(result[0], 6)} USDG (gas est ${result[1]})`);

console.log("4) Universal Router presence (garbage selector → revert = contract)…");
try {
  await c.call({ to: UNIVERSAL_ROUTER, data: "0xdeadbeef" });
  console.log("   ✗ EMPTY return — UR is NOT deployed there!");
  process.exit(1);
} catch {
  console.log("   ✓ Universal Router confirmed (reverts like a contract)");
}

function getPoolId(pk) {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("address,address,uint24,int24,address"),
    [pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks],
  ));
}
