/**
 * Probe OPAI's real V4 pools (native-ETH and WETH variants) + dry-run both
 * buy shapes. Read-only: eth_call / estimateGas only.
 */
import { createPublicClient, http, parseEther, keccak256, encodeAbiParameters, parseAbi, parseAbiParameters, encodeFunctionData, getAddress } from "viem";

const key = process.env.ALCHEMY_API_KEY;
const url = key ? `https://robinhood-mainnet.g.alchemy.com/v2/${key}` : "https://rpc.mainnet.chain.robinhood.com";
const c = createPublicClient({ transport: http(url) });

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const UR = "0x8876789976decbfcbbbe364623c63652db8c0904";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const ETH = "0x0000000000000000000000000000000000000000";
const HOOKS = "0x1888f5c80407755b62d549016cacf84277ab0144";
const TOKEN = "0x39252e514880c1640f7466818a98412cc596b16c"; // OPAI
const signer = getAddress("0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb");

const STATE_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);

function poolIdFor(k) {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]
  ));
}
const mk = (c0, c1) => ({ currency0: c0, currency1: c1, fee: 100, tickSpacing: 1, hooks: HOOKS });

for (const [label, k] of [["native-ETH/OPAI", mk(ETH, TOKEN)], ["WETH/OPAI", mk(WETH, TOKEN)]]) {
  const id = poolIdFor(k);
  try {
    const slot0 = await c.readContract({ address: STATE_VIEW, abi: STATE_ABI, functionName: "getSlot0", args: [id] });
    const liq = await c.readContract({ address: STATE_VIEW, abi: STATE_ABI, functionName: "getLiquidity", args: [id] });
    // quote 0.005 ETH-equivalent: token is currency1, sell currency0 → zeroForOne=true
    let quote = null;
    try {
      const r = await c.simulateContract({
        address: QUOTER, abi: QUOTER_ABI, functionName: "quoteExactInputSingle", account: signer,
        args: [{ poolKey: k, zeroForOne: true, exactAmount: parseEther("0.005"), hookData: "0x" }],
      });
      quote = { out: r.result[0].toString(), gas: r[1]?.toString?.() };
    } catch (e) { quote = { err: String(e.message).slice(0, 80) }; }
    console.log(label, "poolId", id.slice(0, 18) + "…", "sqrtPrice", slot0[0].toString(), "liq", liq.toString(), "quote:", JSON.stringify(quote));
  } catch (e) {
    console.log(label, "— pool not initialized:", String(e.message).slice(0, 100));
  }
}

// Dry-run helper: build the wrap-first 0x0c10 shape against a given poolKey
function buildWrapBuyCall(pk, shape = "single") {
  const wn = (n) => BigInt(n).toString(16).padStart(64, "0");
  const addr = (a) => a.slice(2).toLowerCase().padStart(64, "0");
  const amountIn = parseEther("0.005");
  const amountOutMin = 0n; // ignore slippage guard for the shape probe
  const zeroForOne = pk.currency0.toLowerCase() === WETH;
  let actions, swapParams, settleParams;
  if (zeroForOne) {
    // Proven single-hop shape (0x060c0f), same as the native-ETH buy but the
    // input currency is the wrapped WETH delivered by the WRAP command.
    actions = "0x060c0f";
    swapParams = encodeAbiParameters(
      parseAbiParameters("(address,address,uint24,int24,address), bool, uint128, uint128, bytes"),
      [[pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks], zeroForOne, amountIn, amountOutMin, "0x"],
    );
    settleParams = encodeAbiParameters(parseAbiParameters("address, uint256"), [pk.currency0, amountIn]);
  } else {
    actions = "0x070b0e";
    const pathOffset = 5 * 32, emptyFieldOffset = 5 * 32 + 8 * 32;
    const tuple = [
      addr(pk.currency0), wn(pathOffset), wn(emptyFieldOffset), wn(amountIn), wn(amountOutMin),
      wn(1), wn(0x20), addr(pk.currency1), wn(pk.fee), wn(pk.tickSpacing), addr(pk.hooks), wn(0xa0), wn(0), wn(0),
    ];
    swapParams = "0x" + wn(0x20) + tuple.join("");
    settleParams = encodeAbiParameters(parseAbiParameters("address currency, uint256 amount, bool payerIsUser"), [pk.currency0, 0n, false]);
  }
  const takeParams = encodeAbiParameters(parseAbiParameters("address currency, address recipient, uint256 amount"), [pk.currency1, UR, 0n]);
  const v4Payload = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [swapParams, settleParams, takeParams]]);
  return {
    to: UR,
    data: encodeFunctionData({
      abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
      functionName: "execute",
      args: ["0x0c10", [
        encodeAbiParameters(parseAbiParameters("uint256 amount, address recipient"), [amountIn, UR]), // wrap → router
        v4Payload,
      ], BigInt(Math.floor(Date.now() / 1000) + 300)],
    }),
    value: amountIn,
  };
}

for (const [label, k] of [["native-ETH/OPAI", mk(ETH, TOKEN)], ["WETH/OPAI", mk(WETH, TOKEN)]]) {
  const call = buildWrapBuyCall(k);
  try {
    const gas = await c.estimateGas({ to: call.to, data: call.data, value: call.value, account: signer });
    console.log("DRYRUN", label, "wrap-first shape: PASS gas", gas.toString());
  } catch (e) {
    const sig = String(e.message).match(/0x[a-f0-9]{8}/)?.[0] ?? "?";
    console.log("DRYRUN", label, "wrap-first shape: FAIL", sig, String(e.message).slice(0, 80));
  }
}
