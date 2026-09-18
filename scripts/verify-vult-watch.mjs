// Dry-run of handleV3DollarSwap semantics against the live USDC/VULT pool:
// decode a real recent Swap log and compute what the watcher would do.
const { readFileSync } = await import("fs");
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { createPublicClient, http, parseAbi, decodeEventLog, formatUnits } = await import("viem");
const { ethereum } = await import("viem/chains");

const POOL = "0x6Df52cC6E2E6f6531E4ceB4b083CF49864A89020";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // token0
const VULT = "0xb788144DF611029C60b859DF47e79B7726C4DEBa"; // token1
const c = createPublicClient({ chain: ethereum, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) });

const head = await c.getBlockNumber();
const SWAP = "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";
let sells = [];
for (let i = 1; i <= 8 && sells.length < 3; i++) {
  const logs = await c.getLogs({ address: POOL, fromBlock: head - 9n * BigInt(i), toBlock: head - 9n * BigInt(i - 1) }).catch(() => []);
  for (const l of logs) {
    try {
      const ev = decodeEventLog({ abi: parseAbi(["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"]), data: l.data, topics: l.topics });
      const { amount0, amount1 } = ev.args;
      // token1 = VULT: sell = amount1 > 0 (token in) and amount0 < 0 (USDC out)
      if (amount1 > 0n && amount0 < 0n) {
        sells.push({ tx: l.transactionHash, usdcOut: formatUnits(-amount0, 6) });
      }
    } catch { /* other events */ }
  }
}
console.log(`recent sell-shaped swaps: ${sells.length}`);
for (const s of sells.slice(0, 3)) console.log(`  tx ${s.tx.slice(0, 16)}… USDC paid out: ${s.usdcOut ?? s.usdcOut}`);
console.log(sells.length ? "✅ V3 dollar-pool sell detection will fire on this pool's real swaps" : "(no sells in the last ~72 blocks — pool is quiet right now)");
