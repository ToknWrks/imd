/**
 * diag-atlantis-replay.mjs — decode the EXACT amountIn/minOut from the user's
 * reverted calldata, compare against on-chain balance, and eth_estimateGas a
 * byte-identical reconstruction. Read-only.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

for (const line of readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { createPublicClient, http, parseAbi, encodeAbiParameters, parseAbiParameters, encodeFunctionData } = await import("viem");
const { getChain } = await import("../chains.mjs");
const dep = getChain("robinhood");
const c = createPublicClient({ transport: http(dep.httpRpc()) });

const WALLET = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";
const ATL = "0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18";
const STOCK = "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD";
const HOOK = "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544";

// Words pulled from the user's reverted execute() args (swap params section).
const amountInHex = "0x148d41c58078ff0000";
const stockMinHex = "0x6d5f5f3ff3d9a";
const amountIn = BigInt(amountInHex);
const stockMin = BigInt(stockMinHex);

console.log("user amountIn :", amountIn.toString());
console.log("user stockMin :", stockMin.toString());

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"]);
const bal = await c.readContract({ address: ATL, abi: ERC20, functionName: "balanceOf", args: [WALLET] });
console.log("balance       :", bal.toString());
console.log("amountIn > balance?", amountIn > bal, amountIn > bal ? `(excess ${(amountIn - bal).toString()} raw)` : "");

// stock token decimals (to sanity-check minOut units)
let stockDec = 18;
try { stockDec = await c.readContract({ address: STOCK, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" }); } catch {}
console.log("stock decimals:", stockDec);
console.log("user stockMin in whole stock:", Number(stockMin) / 10 ** Number(stockDec));

// live spot from slot0 (currency0=ATL is token0? currency0=ATL, currency1=STOCK →
// s² = raw1/raw0 = stockRaw per tokenRaw when decimals equal)
const SV = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint16 protocolFee, uint16 lpFee)"]);
const POOL_ID = "0xac3ed4bca616d07d9b5771a88e05f698eb66fe4be7764ff3cffb1674af0bc039";
const s0 = await c.readContract({ address: dep.v4.stateView, abi: SV, functionName: "getSlot0", args: [POOL_ID] });
const s = Number(s0[0]) / 2 ** 96;
const spotRaw = Number(s0[0]) ** 0 / 1; // placeholder
const sNum = Number(s0[0]) / 2 ** 96;
const stockPerToken = sNum * sNum; // both 18 decimals assumed
console.log("spot (s²):", stockPerToken, "→ achievable stock for amountIn:", (Number(amountIn) * stockPerToken).toExponential(6));
console.log("user minOut vs achievable: ratio =", Number(stockMin) / (Number(amountIn) * stockPerToken));

// rebuild byte-identical calldata with the user's numbers
const wn = (x) => BigInt(x).toString(16).padStart(64, "0");
const ad = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const swapParams = "0x" + wn(0x20) + [
  ad(ATL), wn(5 * 32), wn(13 * 32), wn(amountIn), wn(stockMin),
  wn(1), wn(0x20), ad(STOCK), wn(8388608), wn(8), ad(HOOK), wn(0xa0), wn(0), wn(0),
].join("");
const settleParams = encodeAbiParameters(parseAbiParameters("address currency, uint256 amount, bool payerIsUser"), [ATL, 0n, true]);
const takeParams = encodeAbiParameters(parseAbiParameters("address currency, address recipient, uint256 amount"), [STOCK, WALLET, 0n]);
const payload = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), ["0x070b0e", [swapParams, settleParams, takeParams]]);
const data = encodeFunctionData({
  abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
  functionName: "execute",
  args: ["0x10", [payload], 1789077046n], // the user's exact deadline
});
try {
  const gas = await c.estimateGas({ account: WALLET, to: dep.v4.universalRouter, data, value: 0n });
  console.log("✅ EXACT user calldata PASSES now, gas:", gas.toString());
} catch (e) {
  console.log("❌ EXACT user calldata FAILS:", String(e.message).slice(0, 250));
}
