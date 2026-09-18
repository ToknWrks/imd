/** Verify the quote-direction fix + measure OPAI's sell-tax decay. (read-only) */
import { createPublicClient, http, parseEther, parseAbi, formatEther, formatUnits } from "viem";
const key = process.env.ALCHEMY_API_KEY;
const c = createPublicClient({ transport: http(key ? `https://robinhood-mainnet.g.alchemy.com/v2/${key}` : "https://rpc.mainnet.chain.robinhood.com") });
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const OPAI = "0x39252e514880c1640f7466818a98412cc596b16c";
const HOOKS = "0x1888f5c80407755b62d549016cacf84277ab0144";
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
const pk = { currency0: WETH, currency1: OPAI, fee: 100, tickSpacing: 1, hooks: HOOKS };

// 1) BUY direction (the fix): WETH → OPAI with 0.005 ETH in
const buy = await c.simulateContract({
  address: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94", abi: QUOTER_ABI,
  functionName: "quoteExactInputSingle",
  args: [{ poolKey: pk, zeroForOne: true, exactAmount: parseEther("0.005"), hookData: "0x" }],
});
console.log("BUY 0.005 ETH →", formatUnits(buy.result[0], 18), "OPAI (was 3.1e-10 garbage before the fix)");

// 2) SELL ladder: does the hook's sell tax decay over size/time?
for (const amt of ["1000", "10000", "49473"]) {
  const sell = await c.simulateContract({
    address: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94", abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: pk, zeroForOne: false, exactAmount: BigInt(amt) + "0".repeat(18), hookData: "0x" }],
  });
  const wethOut = formatEther(sell.result[0]);
  const opaiInEth = amt === "1000" ? null : null;
  console.log(`SELL ${amt} OPAI → ${wethOut} WETH`);
}
