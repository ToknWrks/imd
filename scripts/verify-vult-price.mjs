// Clean check: pool-implied VULT price + resulting liquidityUsd ranking.
const { readFileSync } = await import("fs");
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { createPublicClient, http } = await import("viem");
const { ethereum } = await import("viem/chains");
const c = createPublicClient({ chain: ethereum, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) });

const POOL = "0x6Df52cC6E2E6f6531E4ceB4b083CF49864A89020";
const res = await c.request({ method: "eth_call", params: [{ to: POOL, data: "0x3850c7bd" }, "latest"] });
const sqrtPriceX96 = BigInt("0x" + res.slice(2, 66));
const s = Number(sqrtPriceX96) / 2 ** 96;
const raw = s * s; // raw1/raw0 = VULT_raw per USDC_raw
// tokenIs0=false (VULT is token1, 18dp; USDC 6dp):
const usdPerVult = (1 / raw) * 10 ** (18 - 6);
console.log("USDC per VULT:", usdPerVult.toFixed(6));
console.log("→ VULT ≈ $" + usdPerVult.toFixed(4));
