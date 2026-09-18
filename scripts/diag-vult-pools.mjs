// VULT pool map — correct slot0 decode (raw eth_call) + reserve sizes.
const { readFileSync } = await import("fs");
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { createPublicClient, http, parseAbi, formatUnits, decodeFunctionResult, encodeFunctionData } = await import("viem");
const { ethereum } = await import("viem/chains");

const VULT = "0xb788144DF611029C60b859DF47e79B7726C4DEBa";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const c = createPublicClient({ chain: ethereum, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) });

console.log("Uniswap V3 pools:");
const FACTORY_ABI = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
const POOL_ABI = parseAbi(["function token0() view returns (address)", "function liquidity() view returns (uint128)"]);
const SLOT0 = "slot0() returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, uint8 unlockCallback)";
for (const [quote, qn, dec] of [[WETH, "WETH", 18], [USDC, "USDC", 6], [USDT, "USDT", 6]]) {
  for (const fee of [100, 500, 3000, 10000]) {
    const pool = await c.readContract({ address: V3_FACTORY, abi: FACTORY_ABI, functionName: "getPool", args: [VULT, quote, fee] }).catch(() => null);
    if (!pool || pool === "0x0000000000000000000000000000000000000000") continue;
    const [t0, liq] = await Promise.all([
      c.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }),
      c.readContract({ address: pool, abi: POOL_ABI, functionName: "liquidity" }),
    ]);
    const data = encodeFunctionData({ abi: parseAbi([`function ${SLOT0}`]), functionName: "slot0" });
    const res = await c.request({ method: "eth_call", params: [{ to: pool, data }, "latest"] });
    const s0 = decodeFunctionResult({ abi: parseAbi([`function ${SLOT0}`]), functionName: "slot0", data: res });
    const vultIs0 = t0.toLowerCase() === VULT.toLowerCase();
    const sqrtP = Number(s0[0]) / 2 ** 96;
    const vultPerQuote = vultIs0 ? sqrtP * sqrtP : 1 / (sqrtP * sqrtP);
    console.log(`  ${qn} fee=${fee}: ${pool}`);
    console.log(`    liq=${liq.toString()} tick=${s0[1]} price=${vultPerQuote.toExponential(4)} VULT per ${qn}`);
  }
}

console.log("\nUniswap V2 pairs:");
const V2_ABI = parseAbi(["function getPair(address, address) view returns (address)", "function getReserves() view returns (uint112, uint112, uint32)", "function token0() view returns (address)"]);
for (const [quote, qn, dec] of [[WETH, "WETH", 18], [USDC, "USDC", 6]]) {
  const pair = await c.readContract({ address: V2_FACTORY, abi: V2_ABI, functionName: "getPair", args: [VULT, quote] }).catch(() => "0x0000000000000000000000000000000000000000");
  if (!pair || pair === "0x0000000000000000000000000000000000000000") { console.log(`  ${qn}: none`); continue; }
  const [t0, r] = await Promise.all([
    c.readContract({ address: pair, abi: V2_ABI, functionName: "token0" }),
    c.readContract({ address: pair, abi: V2_ABI, functionName: "getReserves" }),
  ]);
  const vultIs0 = t0.toLowerCase() === VULT.toLowerCase();
  const vultRes = vultIs0 ? r[0] : r[1];
  const quoteRes = vultIs0 ? r[1] : r[0];
  console.log(`  ${qn}: ${pair} reserves: ${formatUnits(vultRes, 18).slice(0, 12)} VULT / ${formatUnits(quoteRes, dec).slice(0, 12)} ${qn}`);
}
