/**
 * diag-atlantis-pct.mjs — test the hook-fee hypothesis: simulate the UR
 * leg-1 execute() at 100% / 99.9% / 99% / 95% of balance and read the pool's
 * live lpFee from slot0. Finds the max sellable fraction. Read-only.
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
const POOL_ID = "0xac3ed4bca616d07d9b5771a88e05f698eb66fe4be7764ff3cffb1674af0bc039";
const venue = {
  poolKey: {
    currency0: "0x26915c10e8Ce9fb86B836fE8B129A1c5c3771E18",
    currency1: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD",
    fee: 8388608,
    tickSpacing: 8,
    hooks: "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544",
  },
  poolId: POOL_ID,
};

// live slot0 → sqrtPrice + lpFee (dynamic fee is read here by hooks)
const SV = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint16 protocolFee, uint16 lpFee)"]);
const s0 = await c.readContract({ address: dep.v4.stateView, abi: SV, functionName: "getSlot0", args: [POOL_ID] });
console.log("live slot0: lpFee =", Number(s0[3]), "(", (Number(s0[3]) / 100).toFixed(2), "% ) sqrtPrice =", s0[0].toString());

const bal = 97053059907225742322019n;
const spot = 2.0438412913959115e-8; // stock per token (slot0, from earlier rehearsal)

const wn = (x) => BigInt(x).toString(16).padStart(64, "0");
const ad = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

for (const pct of [100, 99.9, 99.5, 99, 98, 95]) {
  const amountIn = (bal * BigInt(Math.round(pct * 100))) / 10000n;
  const stockMin = BigInt(Math.floor(Number(amountIn) * spot * (1 - 0.03)));
  const swapParams = "0x" + wn(0x20) + [
    ad(ATL), wn(5 * 32), wn(13 * 32), wn(amountIn), wn(stockMin),
    wn(1), wn(0x20), ad(STOCK), wn(8388608), wn(8), ad("0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544"), wn(0xa0), wn(0), wn(0),
  ].join("");
  const settleParams = encodeAbiParameters(parseAbiParameters("address currency, uint256 amount, bool payerIsUser"), [ATL, 0n, true]);
  const takeParams = encodeAbiParameters(parseAbiParameters("address currency, address recipient, uint256 amount"), [STOCK, WALLET, 0n]);
  const payload = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), ["0x070b0e", [swapParams, settleParams, takeParams]]);
  const data = encodeFunctionData({
    abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
    functionName: "execute",
    args: ["0x10", [payload], BigInt(Math.floor(Date.now() / 1000) + 300)],
  });
  try {
    const gas = await c.estimateGas({ account: WALLET, to: dep.v4.universalRouter, data, value: 0n });
    console.log(`${pct}% (raw ${amountIn.toString()}): ✅ PASS gas=${gas.toString()}`);
  } catch (e) {
    const raw = JSON.stringify(e, Object.getOwnPropertyNames(e));
    const msg = (e.message ?? "").slice(0, 120);
    console.log(`${pct}% (raw ${amountIn.toString()}): ❌ FAIL ${msg}`);
  }
}
