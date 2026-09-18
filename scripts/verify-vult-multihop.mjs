// Verify the VULT multi-hop buy path end to end WITHOUT sending a tx:
// buyToken routing decision + QuoterV2 quoteExactInput over WETH→USDC→VULT.
const { readFileSync } = await import("fs");
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { createPublicClient, http, parseAbi, encodePacked, formatUnits } = await import("viem");
const { ethereum } = await import("viem/chains");

const VULT = "0xb788144DF611029C60b859DF47e79B7726C4DEBa";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const KEY = process.env.ALCHEMY_API_KEY;
const c = createPublicClient({ chain: ethereum, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${KEY}`) });

// 1) dollar-leg pool exists?
const factory = await c.readContract({
  address: V3_FACTORY, abi: parseAbi(["function getPool(address,address,uint24) view returns (address)"]),
  functionName: "getPool", args: [WETH, USDC, 500],
});
console.log("WETH/USDC 0.05% pool:", factory);
if (factory === "0x0000000000000000000000000000000000000000") process.exit(1);

// 2) full-path quote: 0.004 ETH (~$10) → USDC → VULT
const path = encodePacked(["address", "uint24", "address", "uint24", "address"], [WETH, 500, USDC, 10000, VULT]);
const { result } = await c.simulateContract({
  address: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  abi: parseAbi(["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"]),
  functionName: "quoteExactInput", args: [path, 4000000000000000n],
});
console.log(`quoteExactInput WETH→USDC→VULT for 0.004 ETH: ${formatUnits(result[0], 18)} VULT (gas est ${result[3]})`);
if (result[0] > 0n) console.log("✅ multi-hop path is valid and liquid");
else console.log("❌ quote returned 0 — path problem");
