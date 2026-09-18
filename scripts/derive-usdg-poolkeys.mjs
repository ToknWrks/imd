/**
 * derive-usdg-poolkeys.mjs — derive ETH/USDG V4 poolKeys on 4663 from the
 * poolIds Dexscreener reports, using pure keccak brute-force (no RPC scan).
 * Then confirms each against the StateView.
 */
import { createPublicClient, http, parseAbi, keccak256, encodeAbiParameters, parseAbiParameters, formatUnits } from "viem";
import { robinhood } from "./chain-robinhood.mjs";

const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const SV = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const QT = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const ETH0 = "0x0000000000000000000000000000000000000000";

const SLOT0_ABI = parseAbi(["function getSlot0(bytes32) view returns (uint160,int24,uint16,uint16)"]);
const LIQ_ABI = parseAbi(["function getLiquidity(bytes32) view returns (uint128)"]);
const QUOTE_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

// All (fee, tickSpacing) pairs observed in the genesis Initialize scan
const FEE_TS = [
  [30000, 600], [10000, 200], [2980, 60], [5000, 100], [4900, 98], [8000, 160],
  [8430, 169], [4000, 80], [7530, 151], [9850, 197], [2786, 56], [1000, 20], [3570, 71],
  [100, 1], [500, 10], [3000, 60], [10000, 200], [100000, 2000], [300000, 6000],
];

// Dexscreener's ETH/USDG pools (pairAddress values), largest first
const DEXSCREENER_POOL_IDS = [
  "0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551",
  "0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32",
  "0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e",
  "0xccadcfb77490b11197023c2caf26e259cf8799b90f6f3a1853b32b986b9f801e",
  "0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6",
  "0xd4e6249897f2c30B3AB4b7946d2bE1D8ACD8C8eA".toLowerCase().padEnd(66, "0"),
];

const encode = (k) => keccak256(encodeAbiParameters(
  parseAbiParameters("address,address,uint24,int24,address"),
  [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
));

console.log("Deriving poolKeys for Dexscreener's ETH/USDG pools…\n");
const results = [];
for (const poolId of DEXSCREENER_POOL_IDS) {
  if (poolId.length !== 66) { console.log(`skip malformed ${poolId.slice(0, 20)}`); continue; }
  let hit = null;
  for (const [fee, ts] of FEE_TS) {
    const key = { currency0: ETH0, currency1: USDG, fee, tickSpacing: ts, hooks: ETH0 };
    if (derivePoolId(key) === poolId) { hit = key; break; }
  }
  if (!hit) { console.log(`${poolId.slice(0, 14)}… — poolKey not derivable (maybe hooked or ordering differs)`); continue; }
  // Confirm live via StateView
  try {
    const [sqrtPriceX96, tick] = await c.readContract({ address: SV, abi: SLOT0_ABI, functionName: "getSlot0", args: [poolId] });
    const liquidity = await c.readContract({ address: SV, abi: LIQ_ABI, functionName: "getLiquidity", args: [poolId] });
    const s = Number(sqrtPriceX96) / 2 ** 96;
    const usdgPerEth = s * s * 10 ** 12;
    console.log(`${poolId} fee=${hit.fee} ts=${hit.tickSpacing} liq=${liquidity} → 1 ETH = ${usdgPerEth.toFixed(2)} USDG`);
    results.push({ poolId, ...hit, liquidity: liquidity.toString() });
  } catch (e) {
    console.log(`${poolId.slice(0, 14)}… poolKey derived but StateView call failed: ${e.message.slice(0, 60)}`);
  }
}

function derivePoolId(pk) {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("address,address,uint24,int24,address"),
    [pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks],
  ));
}
