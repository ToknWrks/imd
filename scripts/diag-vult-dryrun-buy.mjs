// Dry-run the FULL multi-hop buy calldata (exactInput + refundETH multicall,
// msg.value attached) via eth_call from the wallet — no transaction is sent.
import { readFileSync } from "fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { createPublicClient, http, parseAbi, encodeFunctionData, encodePacked, formatUnits } = await import("viem");
const { ethereum } = await import("viem/chains");

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const VULT = "0xb788144DF611029C60b859DF47e79B7726C4DEBa";
const ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // SwapRouter02 mainnet
const WALLET = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";
const c = createPublicClient({ chain: ethereum, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) });

const ROUTER_ABI = parseAbi([
  "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
  "function refundETH() payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

const amountIn = 4000000000000000n; // ~$10 of ETH
const path = encodePacked(["address","uint24","address","uint24","address"], [WETH, 500, USDC, 10000, VULT]);
// min out = 0 for the dry run (we just want the swap itself to succeed)
const params = { path, recipient: WALLET, amountIn, amountOutMinimum: 0n };
const exactInputCalldata = encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInput", args: [params] });
const refundETHCalldata = encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" });

try {
  const { result } = await c.simulateContract({
    address: ROUTER, abi: ROUTER_ABI, functionName: "multicall",
    args: [[exactInputCalldata, refundETHCalldata]], value: amountIn, account: WALLET,
  });
  console.log("✅ multicall simulated successfully from", WALLET);
  console.log("results:", result.map((r) => r.slice(0, 10) + "…"));
} catch (e) {
  console.log("❌ simulation failed:", String(e.message).slice(0, 400));
}
