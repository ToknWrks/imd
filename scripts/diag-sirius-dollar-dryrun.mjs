// Dry-run the full scheduled-buy path for SIRIUS exactly as dip-watcher now
// runs it: buyToken -> buyDipWithDollar -> Permit2 checks -> eth_estimateGas.
// NO FUNDS MOVE.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { resolvePoolOverride, buyDipWithDollar, getEthUsdPrice } = await import("../dip-swap.mjs");
const { getChain, httpClient } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");
const { encodeFunctionData, parseAbi } = await import("viem");

const ERC20_BALANCE_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const TOKEN = "0x3b4A0048a00787A644932cD648Faa043410C163e";
const CHAIN = "robinhood";
const POOL_OVERRIDE = "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b";
const BUY_USD = 2;

const dep = getChain(CHAIN);
const client = httpClient(CHAIN);
const signer = await resolveSigner(CHAIN);
console.log("signer:", signer.address, "| chain:", dep.name);

const dollar = dep.dollar;
const usdgBal = await client.readContract({ address: dollar, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [signer.address] });
console.log("USDG balance:", Number(usdgBal) / 1e6);

// Rebuild the exact calldata buyDipWithDollar will send (mirror of its body
// up to the send), then estimate-gas it.
const venue = await resolvePoolOverride(TOKEN, POOL_OVERRIDE, CHAIN);
console.log("venue poolId:", venue.poolId, "fee", venue.poolKey.fee, "ts", venue.poolKey.tickSpacing, "hooks", venue.poolKey.hooks);

// quote via the module (uses quoteExactInV4 internally; call through the
// exported executor's build step by monkey-observing: just re-derive here)
const amountInRaw = BigInt(Math.round(BUY_USD * 10 ** dep.dollarDecimals));
console.log("input:", BUY_USD, "USDG =", amountInRaw.toString(), "raw");

const { quoteExactInV4 } = await import("../dip-swap.mjs").then((m) => ({ quoteExactInV4: m.quoteExactInV4 ?? null }));
// quoteExactInV4 is module-private; get the quote via the exported buy path's
// console output instead — run the FULL flow but intercept before sending by
// stubbing signer.callContract for the swap only.

let swapCall = null;
const realCallContract = signer.callContract.bind(signer);
signer.callContract = async (call) => {
  if (call.functionName === "execute" && !swapCall) {
    swapCall = call; // capture the swap call, don't send
    throw new Error("DRY-RUN-STOP (captured swap call — this is expected)");
  }
  // Permit2 approval calls: also capture, don't send
  if (call.functionName === "approve") {
    console.log("  [would send] approve:", call.address, "args:", call.args?.map(String));
    throw new Error("DRY-RUN-STOP-APPROVE (expected)");
  }
  return realCallContract(call);
};

try {
  await buyDipWithDollar(signer, TOKEN, BUY_USD, { slippagePct: 3, pool: venue, chainKey: CHAIN });
  console.log("UNEXPECTED: swap went through?!");
} catch (e) {
  if (!/DRY-RUN-STOP/.test(e.message)) {
    console.log("FAILED EARLY (real error):", e.message.slice(0, 300));
    process.exit(1);
  }
}

if (!swapCall) { console.log("no swap call captured (failed before building it)"); process.exit(1); }
const data = encodeFunctionData({ abi: swapCall.abi, functionName: swapCall.functionName, args: swapCall.args });
console.log("\ncaptured swap calldata (first 80 bytes):", data.slice(0, 178), "…");
try {
  const gas = await client.request({ method: "eth_estimateGas", params: [{ from: signer.address, to: swapCall.address, data, value: "0x0" }] });
  console.log("✅ estimateGas OK:", BigInt(gas).toString(), "— the dollar-buy would succeed on-chain");
} catch (e) {
  console.log("❌ estimateGas FAILED (same as the real error):");
  console.log(e.message.slice(0, 500));
}
