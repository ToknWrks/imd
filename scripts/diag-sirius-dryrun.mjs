// Reproduce the SIRIUS scheduled-buy failure WITHOUT sending a tx.
// Same path as dip-watcher: resolvePoolOverride (manual pool) -> quoteBuyV4
// -> buildV4BuyCall -> eth_estimateGas. No funds move.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const TOKEN = "0x3b4A0048a00787A644932cD648Faa043410C163e";
const CHAIN = "robinhood";
const POOL_OVERRIDE = "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b";
const BUY_USD = 2;

const { resolvePoolOverride, buildV4BuyCall, quoteBuyV4, getEthUsdPrice } = await import("../dip-swap.mjs");
const { getChain, httpClient } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");
const { encodeFunctionData } = await import("viem");

const dep = getChain(CHAIN);
const client = httpClient(CHAIN);
const signer = await resolveSigner(CHAIN);
console.log("signer:", signer.address, "| chain:", dep.name);

const ethUsd = await getEthUsdPrice(CHAIN);
console.log("ETH/USD:", Number(ethUsd).toFixed(2));
const ethAmountWei = BigInt(Math.round((BUY_USD / Number(ethUsd)) * 1e18));
console.log(`buying $${BUY_USD} = ${Number(ethAmountWei) / 1e18} ETH`);

const venue = await resolvePoolOverride(TOKEN, POOL_OVERRIDE, CHAIN);
console.log("override venue:", JSON.stringify(venue, (k, v) => (typeof v === "bigint" ? String(v) : v)));
if (!venue) { console.log("override did not resolve — that's the bug"); process.exit(0); }

try {
  const q = await quoteBuyV4(venue, ethAmountWei, CHAIN);
  console.log("quote OK:", Number(q) / 1e18, "tokens");
} catch (e) {
  console.log("QUOTE FAILED:", e.message.slice(0, 300));
}

try {
  const { call, quotedOut, amountOutMinimum, isHooked } = await buildV4BuyCall(venue, TOKEN, ethAmountWei, { slippagePct: 3, recipient: signer.address, chainKey: CHAIN });
  console.log("built call: hooked =", isHooked, "| quotedOut", Number(quotedOut) / 1e18, "| minOut", Number(amountOutMinimum) / 1e18);
  const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args });
  try {
    const gas = await client.request({ method: "eth_estimateGas", params: [{ from: signer.address, to: call.address, data, value: "0x" + ethAmountWei.toString(16) }] });
    console.log("estimateGas OK:", BigInt(gas));
  } catch (e) {
    console.log("ESTIMATE GAS FAILED (this is the real-buy error):");
    console.log(e.message.slice(0, 600));
  }
} catch (e) {
  console.log("BUILD FAILED:", e.message.slice(0, 300));
}
