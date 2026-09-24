/**
 * IMD → ETH sell encoder test (offline). Pins buildImdEthSwapCall to the
 * on-chain ground truth, tx 0x6fbc3188…(block 26036791): the V4_SWAP input the
 * Uniswap UI sent to the hook-router. Our builder differs ONLY where intended:
 *   - maxHopSlippage: [] (reference carried one per-hop price bound)
 *   - amountOutMinimum / amountIn / recipient are per-trade values
 * Everything else (actions 0x070b0e, pool key, hook, SETTLE/TAKE shapes,
 * target = hook-router, command 0x10) must match byte-for-byte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, decodeAbiParameters, parseAbiParameters, encodeFunctionData, getAddress } from "viem";
import { buildImdEthSwapCall, EXECUTE_ABI, HOOK_ROUTER, IMD, HOOKED_POOL } from "./v4-hook-sell.mjs";

// Reference values decoded from tx 0x6fbc3188… (see docs/buy-sell-imd.md).
const REF_SELLER = "0xa71fb297aa443adfc22ff74981d8c067ec3475cb";
const REF_AMOUNT_IN = 1000000000000000000n;
const REF_MIN_OUT = 2121703962343418n;
const REF_SETTLE = "0x000000000000000000000000d34a99bc0f67ae1bbd63c660e6d0b0dd03e263b700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001";
const REF_TAKE = "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a71fb297aa443adfc22ff74981d8c067ec3475cb0000000000000000000000000000000000000000000000000000000000000000";
const PATH_KEY = "(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)";
const SWAP_T = `(address currencyIn, ${PATH_KEY}[] path, uint256[] maxHopSlippage, uint128 amountIn, uint128 amountOutMinimum)`;

test("IMD sell targets the hook-router with command 0x10 (never the Universal Router)", () => {
  const call = buildImdEthSwapCall({ amountIn: REF_AMOUNT_IN, minOutWei: REF_MIN_OUT, recipient: REF_SELLER, deadlineSec: 1 });
  assert.equal(getAddress(call.address), getAddress("0x23617e59a5925b2a4bf75d73ff6711cd0b29de85"));
  assert.equal(call.address, HOOK_ROUTER);
  assert.equal(call.functionName, "execute");
  assert.equal(call.args[0], "0x10");
  assert.equal(call.args[1].length, 1);
  assert.equal(call.value, 0n);
});

test("V4_SWAP payload matches the on-chain reference (actions, pool, SETTLE, TAKE)", () => {
  const call = buildImdEthSwapCall({ amountIn: REF_AMOUNT_IN, minOutWei: REF_MIN_OUT, recipient: REF_SELLER, deadlineSec: 1 });
  const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes actions, bytes[] params"), call.args[1][0]);
  assert.equal(actions, "0x070b0e");
  assert.equal(params.length, 3);
  assert.equal(params[1].toLowerCase(), REF_SETTLE, "SETTLE(IMD, 0, payerIsUser=true) must match the reference");
  assert.equal(params[2].toLowerCase(), REF_TAKE, "TAKE(ETH, seller, 0) must match the reference");
  const [swap] = decodeAbiParameters(parseAbiParameters(SWAP_T), params[0]);
  assert.equal(getAddress(swap.currencyIn), getAddress(IMD));
  assert.equal(swap.path.length, 1);
  assert.equal(swap.path[0].intermediateCurrency, "0x0000000000000000000000000000000000000000");
  assert.equal(swap.path[0].fee, HOOKED_POOL.fee);
  assert.equal(swap.path[0].tickSpacing, HOOKED_POOL.tickSpacing);
  assert.equal(getAddress(swap.path[0].hooks), getAddress("0xc6c965bd164c483e87d0b550671798e9a3602840"));
  assert.equal(swap.path[0].hookData, "0x");
  assert.deepEqual(swap.maxHopSlippage, []);
  assert.equal(swap.amountIn, REF_AMOUNT_IN);
  assert.equal(swap.amountOutMinimum, REF_MIN_OUT);
});

test("execute() calldata round-trips through the ABI", () => {
  const call = buildImdEthSwapCall({ amountIn: 5n, minOutWei: 1n, recipient: REF_SELLER, deadlineSec: 1234 });
  const data = encodeFunctionData(call);
  const d = decodeFunctionData({ abi: EXECUTE_ABI, data });
  assert.equal(d.args[0], "0x10");
  assert.equal(d.args[2], 1234n);
});
