// Probe Slipstream factory with V3-style getPool + fee tiers, and PoolManager
// slot0 for LAPTOP's CL pool to sanity-check the earlier CL confirmation.
const { readFileSync } = await import("fs");
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { createPublicClient, http, encodeFunctionData, parseAbi, toFunctionSelector } = await import("viem");
const { base } = await import("viem/chains");

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const LAPTOP = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const F = "0xeC8E5342B19977B4eF8892e02D8DAEcfa1315831";
const POOL = "0x99cf3E8bfB02c300312c53Aac5D0B082e3D5975C";
const c = createPublicClient({ chain: base, transport: http(`https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) });

async function tryCall(sig, args) {
  try {
    const data = encodeFunctionData({ abi: parseAbi([`function ${sig}`]), functionName: sig.split("(")[0], args });
    const res = await c.request({ method: "eth_call", params: [{ to: F, data }, "latest"] });
    console.log("✓", sig, "→", res.slice(0, 70));
    return true;
  } catch (e) {
    console.log("✗", sig, "—", e.message.slice(0, 80).replace(/\n/g, " "));
    return false;
  }
}

// V3 factory style: createPool exists, getPool is a public mapping
await tryCall("getPool(address,address,uint24)", [USDC, LAPTOP, 20000]);
await tryCall("poolByFee(address,address,uint24)", [USDC, LAPTOP, 20000]);
await tryCall("pools(bytes32)", [42n]);
