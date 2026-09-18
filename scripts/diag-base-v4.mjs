#!/usr/bin/env node
// diag-base-v4.mjs — decode the user's WORKING Base swap (V4 via a Universal
// Router at 0xfdf6…fbc7) and replicate it for our wallet: decode, locate the
// V4 pool, quote, and eth_call our own execute.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, "..", ".env"), "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const RAW = "0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000006aa161bf00000000000000000000000000000000000000000000000000000000000000020b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000002386f26fc100000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000217c05f5d1d1e595bbae94534540b803bfc4563b000000000000000000000000000000000000000000000000002386f26fc100000000000000000000000000000000000000000000000000003940ba841e27270900000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000002b4200000000000000000000000000000000000006002710b095274743941e953c746f9c228da9c18bb6ec290000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000756e6978000001a0864a5a558000a8e40000000c0100";
const UR = "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7";
const LAPTOP = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";

const { createPublicClient, http, decodeFunctionData, encodeFunctionData, parseAbi, decodeAbiParameters, parseAbiParameters, encodeAbiParameters, keccak256, toHex } = await import("viem");
const { getChain } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");

const dep = getChain("base");
const c = createPublicClient({ transport: http(dep.httpRpc()) });
const signer = await resolveSigner("base");
const WETH = dep.weth;

console.log("== 1. decode the raw tx ==");
let commands, inputs, deadline, usedSig = null;
for (const sig of ["execute(bytes,bytes[],uint256)", "execute(bytes,bytes[])"]) {
  try {
    const { args } = decodeFunctionData({ abi: parseAbi(["function " + sig + " payable"]), data: RAW });
    usedSig = sig;
    if (sig.includes("uint256")) { [commands, inputs, deadline] = args; } else { [commands, inputs] = args; }
    break;
  } catch {}
}
console.log("  execute selector:", usedSig);
console.log("  commands:", toHex(commands));
if (deadline) console.log("  deadline:", deadline.toString());
console.log("  inputs[]:", inputs.length);

const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes,bytes[]"), inputs[0]);
console.log("  actions:", toHex(actions), "- params[]:", params.length);
params.forEach((p, i) => console.log("    param[" + i + "]:", toHex(p).slice(0, 140), toHex(p).length > 140 ? "..." : ""));

let path, hookData;
try {
  const [p, recipient, amountIn, minOut, hd] = decodeAbiParameters(parseAbiParameters("bytes,address,uint256,uint128,bytes"), params[0]);
  path = p; hookData = hd;
  console.log("\n  SWAP_EXACT_IN decode:");
  console.log("    path:", toHex(p));
  console.log("    recipient:", recipient);
  console.log("    amountIn:", amountIn.toString(), "(" + Number(amountIn) / 1e18, "ETH)");
  console.log("    minOut:", minOut.toString(), "(" + Number(minOut) / 1e18, "LAPTOP)");
  console.log("    hookData:", toHex(hd), "(" + hd.length, "bytes)");
} catch (e) {
  console.log("  param[0] is not a 5-field swap:", e.message.slice(0, 120));
}

if (path) {
  const hex = toHex(path).slice(2);
  const cur0 = "0x" + hex.slice(0, 40);
  const fee = parseInt(hex.slice(40, 46), 16);
  const cur1 = "0x" + hex.slice(46, 86);
  console.log("  path parsed:", cur0, "--fee", fee, "-->", cur1);
}

console.log("\n== 2. locate the V4 pool ==");
const STATE_VIEW_ABI = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint16 protocolFee, uint16 lpFee)"]);
async function probePool(poolKey) {
  const poolId = keccak256(encodeAbiParameters(
    parseAbiParameters("(address,address,uint24,int24,address)"),
    [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]],
  ));
  try {
    const s = await c.readContract({ address: dep.v4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] });
    const arr = Array.isArray(s) ? s : [s.sqrtPriceX96, s.tick, s.protocolFee, s.lpFee];
    if (arr[0] !== 0n) return { poolId, sqrtPriceX96: arr[0], tick: arr[1], lpFee: arr[3] };
  } catch {}
  return null;
}
let pool = null;
for (const ts of [1, 5, 10, 20, 60, 100, 200]) {
  const r = await probePool({ currency0: WETH, currency1: LAPTOP, fee: 10000, tickSpacing: ts, hooks: "0x0000000000000000000000000000000000000000" });
  if (r) { console.log("  FOUND zero-hook pool: ts=" + ts, "poolId=" + r.poolId, "tick=" + r.tick); pool = { ...r, fee: 10000, tickSpacing: ts, hooks: "0x0000000000000000000000000000000000000000" }; break; }
}
if (!pool) {
  console.log("  no zero-hook pool at fee 10000 - scanning Initialize logs...");
  const INIT = parseAbi(["event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks)"]);
  const latest = await c.getBlockNumber();
  let logs = [];
  for (let end = latest; end > latest - 900000n && !logs.length; end -= 30000n) {
    try {
      logs = await c.getLogs({ address: dep.v4.poolManager, event: INIT, args: { currency0: WETH, currency1: LAPTOP }, fromBlock: end - 30000n, toBlock: end });
    } catch (e) { console.log("    range err:", e.message.slice(0, 60)); }
  }
  if (logs.length) {
    for (const l of logs) {
      const { id, fee, tickSpacing, hooks } = l.args;
      console.log("  Initialize:", "poolId=" + id, "fee=" + fee, "ts=" + tickSpacing, "hooks=" + hooks);
      pool = { poolId: id, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks };
    }
  } else console.log("  no Initialize event in recent 900k blocks");
}

console.log("\n== 3. quote + dry-run OUR swap ==");
if (pool) {
  const VALUE = 10000000000000n; // 0.01 ETH like the user's swap
  const { quoteBuyV4, buildV4BuyCall } = await import("../dip-swap.mjs");
  try {
    const q = await quoteBuyV4({ poolId: pool.poolId, poolKey: pool }, VALUE, "base");
    console.log("  our quoteBuyV4 OK:", Number(q) / 1e18, "LAPTOP");
  } catch (e) {
    console.log("  our quoteBuyV4 FAILED (hook may need hookData):", e.message.slice(0, 200));
  }
  try {
    const { call } = await buildV4BuyCall({ poolId: pool.poolId, poolKey: pool }, LAPTOP, VALUE, { slippagePct: 3, recipient: signer.address, chainKey: "base" });
    const res = await fetch("https://base.drpc.org", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ from: signer.address, to: call.address, data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args }), value: "0x" + call.value.toString(16) }, "latest"] }),
    });
    const j = await res.json();
    console.log("  OUR buildV4BuyCall eth_call:", j.error ? "REVERT " + JSON.stringify(j.error).slice(0, 220) : "OK (would swap)");
  } catch (e) {
    console.log("  buildV4BuyCall failed:", e.message.slice(0, 200));
  }
  // replicate the user's exact UR payload with recipient=our wallet
  try {
    const freshHookData = hookData && hookData.length >= 6
      ? ("0x" + toHex(hookData).slice(2).replace(/756e6978[0-9a-f]{16}/, "756e6978" + BigInt(Math.floor(Date.now() / 1000)).toString(16).padStart(16, "0")))
      : "0x";
    const swapParams = encodeAbiParameters(parseAbiParameters("bytes,address,uint256,uint128,bytes"),
      [path, signer.address, VALUE, 1n, freshHookData]);
    const v4Payload = encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [toHex(actions), [swapParams]]);
    const data = encodeFunctionData({
      abi: parseAbi(["function execute(bytes,bytes[],uint256) payable"]),
      functionName: "execute", args: [toHex(commands), [v4Payload], BigInt(Math.floor(Date.now() / 1000) + 300)],
    });
    const res = await fetch("https://base.drpc.org", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ from: signer.address, to: UR, data, value: "0x" + VALUE.toString(16) }, "latest"] }),
    });
    const j = await res.json();
    console.log("  replicated user payload (our wallet):", j.error ? "REVERT " + JSON.stringify(j.error).slice(0, 220) : "OK (would swap)");
  } catch (e) {
    console.log("  replicate failed:", e.message.slice(0, 200));
  }
}
