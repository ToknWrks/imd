// Diagnose why poolId 0x0bcfb8dd… can't have its poolKey derived.
// Path: StateView.getSlot0 (exists?) → Initialize log lookup (getLogs range
// caps?) → brute-force candidates. Try fallback public RPCs for the scan.
const { readFileSync } = await import("fs");
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { createPublicClient, http, parseAbi, keccak256, toHex, encodeAbiParameters } = await import("viem");
const { base } = await import("viem/chains");

const POOL_ID = "0x0bcfb8ddc2af0bc61d72be1daf470c8853f568c4b04f619b0a31f1ced1216c4d";
const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const STATE_VIEW = "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71";
const LAPTOP = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const WETH = "0x4200000000000000000000000000000000000006";
const INIT_ABI = parseAbi(["event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"]);

const alchemy = createPublicClient({ chain: base, transport: http(`https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) });

console.log("1) StateView.getSlot0 — pool exists?");
try {
  const s0 = await alchemy.readContract({ address: STATE_VIEW, abi: parseAbi(["function getSlot0(bytes32) view returns (uint160, int24, uint16, uint16)"]), functionName: "getSlot0", args: [POOL_ID] });
  console.log("   ✓ sqrtPrice:", s0[0].toString(), "tick:", s0[1].toString());
} catch (e) { console.log("   ✗", e.message.slice(0, 120)); }

console.log("2) Initialize log via Alchemy (full range):");
try {
  const logs = await alchemy.getLogs({ address: POOL_MANAGER, event: INIT_ABI[0], args: { id: POOL_ID }, fromBlock: 0n, toBlock: "latest" });
  console.log("   logs:", logs.length);
} catch (e) { console.log("   ✗", e.message.slice(0, 140).replace(/\n/g, " ")); }

const FALLBACKS = [
  ["drpc", "https://base.drpc.org"],
  ["llamarpc", "https://base.llamarpc.com"],
  ["1rpc", "https://1rpc.io/base"],
  ["blastapi", "https://base-mainnet.public.blastapi.io"],
  ["meowrpc", "https://base.meowrpc.com"],
  ["publicnode", "https://base.publicnode.com"],
];
for (const [name, url] of FALLBACKS) {
  try {
    const c = createPublicClient({ chain: base, transport: http(url, { timeout: 15000 }) });
    const logs = await c.getLogs({ address: POOL_MANAGER, event: INIT_ABI[0], args: { id: POOL_ID }, fromBlock: 0n, toBlock: "latest" });
    if (logs.length) {
      const a = logs[0].args;
      console.log(`   ✓ ${name}: currency0=${a.currency0} currency1=${a.currency1} fee=${a.fee} ts=${a.tickSpacing} hooks=${a.hooks}`);
      // verify derivation
      const enc = encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [a.currency0, a.currency1, a.fee, a.tickSpacing, a.hooks]);
      const derived = keccak256(enc);
      console.log(`   derived poolId match: ${derived === POOL_ID ? "✓ EXACT" : "✗ " + derived}`);
      process.exit(0);
    } else {
      console.log(`   ~ ${name}: no logs (empty)`);
    }
  } catch (e) { console.log(`   ✗ ${name}: ${e.message.slice(0, 100).replace(/\n/g, " ")}`); }
}
