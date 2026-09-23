/**
 * v4-hook-sell.mjs — IMD V4 sell into the HOOKED pool (the launchpad trading pool),
 * mirroring the Uniswap UI's proven two-command flow:
 *
 *   execute(commands "0x0a10", [permit2PermitInput, v4SwapInput])
 *
 * The launchpad hook requires the input token to be pulled via a per-trade
 * Permit2 permit (EIP-712, signed by the seller) with spender
 * 0x23617e59a5925b2a4bf75d73ff6711cd0b29de85 — a plain router allowance does
 * NOT satisfy this pool (found live 2026-09-23).
 *
 * Ground truth: the user's UI tx calldata (IMD 1.0 → 0.00212 ETH, pool
 * 0x415829f72e… fee 10000 ts 60 hook 0xc6c965bd…, hookData = seller).
 * Verification for this path is STRUCTURAL (viem-decode diff vs the UI blob) —
 * offline eth_call replay can't validate it because the permit leg carries a
 * signature the replay cannot produce.
 */
import { getAddress, encodeFunctionData, parseAbi, encodeAbiParameters, parseAbiParameters, parseUnits } from "viem";
import { getChain } from "./chains.mjs";

const wn = (x) => BigInt(x).toString(16).padStart(64, "0");
const addr = (a) => getAddress(a).slice(2).toLowerCase().padStart(64, "0");

// From the UI's working sell (IMD/ETH hooked pool):
// IMD token (the launchpad's reserve asset) — the only token this sell path supports.
export const IMD = "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7";
export const HOOKED_POOL = {
  poolId: "0x415829f72e9f54531c26eae76f107618540e898a45d6ae35959e143f5faca704",
  fee: 10000,
  tickSpacing: 60,
  hooks: "0xC6C965BD164C483E87D0B550671798E9A3602840",
};
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
// The spender the hook's permit must approve (from the UI calldata, input[0] word4):
export const HOOK_PERMIT_SPENDER = "0x23617E59A5925B2A4BF75D73FF6711CD0B29DE85";
// The launchpad's V4 hook-router — this contract EXECUTES the sell (NOT the
// Universal Router). Ground truth: tx 0x6fbc3188… (block 26036791) went here,
// not to 0x66a9893c….
export const HOOK_ROUTER = "0x23617E59A5925B2A4BF75D73FF6711CD0B29DE85";
// sqrtPriceLimitX96 the working UI sell carried in the swap tuple's word 16
// (clean on-chain bytes, tx 0x6fbc3188…). A price limit of 0 means "no limit";
// the UI's value implies a bounded slippage for the IMD→ETH direction.
export const SQRT_PRICE_LIMIT = 0x689bab3f3a37da09d5932db10000n;

const EXECUTE_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

/**
 * EIP-712 typed data for the per-trade Permit2 permit (the browser signs THIS).
 * Domain + types per IAllowanceTransfer (Permit2 canonical).
 */
export function permitTypedData({ tokenAddress, sellerAddress, spender = HOOK_PERMIT_SPENDER, expiration, nonce, deadline, chainId = 1 }) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
      PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
    },
    primaryType: "PermitSingle",
    domain: { name: "Permit2", chainId, verifyingContract: getAddress(PERMIT2) },
    message: {
      details: {
        token: getAddress(tokenAddress),
        amount: (2n ** 160n - 1n).toString(),
        expiration,
        nonce,
      },
      spender: getAddress(spender),
      sigDeadline: deadline.toString(),
    },
  };
}

/**
 * Read the current Permit2 nonce for (owner, token, spender) — required to
 * build the typed data the wallet signs. Free on-chain read.
 */
export async function getPermit2Nonce({ ownerAddress, tokenAddress, chainKey = "ethereum" }) {
  const { httpClient } = await import("./chains.mjs");
  const c = httpClient(chainKey);
  const result = await c.readContract({
    address: getAddress(PERMIT2),
    abi: parseAbi(["function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]),
    functionName: "allowance",
    args: [getAddress(ownerAddress), getAddress(tokenAddress), getAddress(HOOK_PERMIT_SPENDER)],
  });
  return BigInt(result[2]);
}

/**
 * Build execute("0x0a10", [permit, swap]) with viem-native encoding throughout —
 * every ABI structure is emitted by encodeAbiParameters/encodeFunctionData with
 * typed components; zero hand-padded hex concatenation.
 *
 * @returns {{ to: string, data: string, value: string }}
 */
export function buildHookedPoolSellCalldata({ tokenAddress, amountHuman, tokenDecimals = 18, sellerAddress, minOutWei, permitSignature, chainKey = "ethereum" }) {
  const token = getAddress(tokenAddress);
  const seller = getAddress(sellerAddress);
  const ETH = getAddress("0x0000000000000000000000000000000000000000");
  const amountIn = typeof amountHuman === "string"
    ? parseUnits(amountHuman, tokenDecimals)
    : BigInt(Math.round(Number(amountHuman) * 10 ** tokenDecimals));

  // ── input[0]: PERMIT2_PERMIT input = abi.encode(PermitSingle, bytes sig)
  const permitInput = encodeAbiParameters(
    parseAbiParameters("(address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline, bytes signature"),
    [{
      token,
      amount: 2n ** 160n - 1n,
      expiration: permitSignature.expiration,
      nonce: permitSignature.nonce,
    }, getAddress(HOOK_PERMIT_SPENDER), permitSignature.deadline, permitSignature.sig]
  );

  // ── input[1]: V4_SWAP input = abi.encode(bytes actions, bytes[] params)
  //    actions 070b0e = SWAP_EXACT_IN, SETTLE_ALL, TAKE_ALL
  //
  //    params[0] = SWAP_EXACT_IN = abi.encode(ExactInputParams) where the tuple is the
  //    PROVEN buildV4ExactInPathPayload layout (buy path, live-verified):
  //      head (5 words): currencyIn, pathOffset, trailingEmptyOffset, amountIn, minOut
  //      member words:   1, 0x20, intermediate, fee, tickSpacing, hooks
  //      path block (8): length(0xa0), elementOffset(0x20), currencyIn, fee, ts, hooks, hookDataOffset(0xa0), hookDataLength(1)
  //      hookData:       abi.encode(seller)
  //    For the sell: currencyIn = token, intermediate = ETH, hookDataLen = 1 (UI tail [0xa0][0][1]).
  const pathHex =
    token.slice(2).toLowerCase() +
    ETH.slice(2).toLowerCase() +
    BigInt(HOOKED_POOL.fee).toString(16).padStart(64, "0") +
    BigInt(HOOKED_POOL.tickSpacing).toString(16).padStart(64, "0") +
    getAddress(HOOKED_POOL.hooks).slice(2).toLowerCase().padStart(64, "0");
  const hookDataHex = seller.slice(2).toLowerCase().padStart(64, "0");

  // ── input[1]: V4_SWAP input = abi.encode(bytes actions, bytes[] params)
  //    actions 070b0e = SWAP_EXACT_IN, SETTLE_ALL, TAKE_ALL
  //
  //    params[0] = SWAP_EXACT_IN — 16 words = 512 bytes (matches the UI's len word 0x200):
  //      [0x20]            tuple offset
  //      [currencyIn]      IMD (we sell the token)
  //      [0xa0]            path offset (HEAD_WORDS=5 × 32)
  //      [0x1a0]           trailing-empty-field offset (pathOffset + 8×32)
  //      [amountIn] [minOut]
  //      [1] [0x20]        published member + its offset (proven buy layout)
  //      [intermediate]    ETH (proceeds)
  //      [fee] [ts] [hooks]
  //      [0xa0] [0] [1]    hookData offset, proven word, hookDataLength=1
  //      [sqrtPriceLimit]  word 16 — the on-chain reference tx (0x6fbc3188…) carries
  //                        0x689bab3f3a37da09d5932db10000 here, NOT the seller. The
  //                        seller appears ONLY in the TAKE recipient. Value decoded
  //                        from clean on-chain bytes 2026-09-23.
  //    This is the PROVEN buildV4ExactInPathPayload (buy) shape with sell deltas:
  //    currencyIn=token, and the trailing word = sqrtPriceLimitX96 (not hookData).
  const swapParams = "0x" + [
    wn(0x20),
    addr(token),
    wn(0xa0),
    wn(0x1a0),
    wn(amountIn),
    wn(minOutWei),
    wn(1),
    wn(0x20),
    addr(ETH),
    wn(HOOKED_POOL.fee),
    wn(HOOKED_POOL.tickSpacing),
    addr(HOOKED_POOL.hooks),
    wn(0xa0),
    wn(0),
    wn(1),
    wn(SQRT_PRICE_LIMIT),
  ].join("");

  const settleParams = encodeAbiParameters(
    parseAbiParameters("address currency, uint256 amount, bool payerIsUser"),
    [token, 0n, true]
  );
  const takeParams = encodeAbiParameters(
    parseAbiParameters("address currency, address recipient, uint256 amount"),
    [ETH, seller, 0n]
  );

  const v4SwapInput = encodeAbiParameters(
    parseAbiParameters("bytes actions, bytes[] params"),
    ["0x070b0e", [swapParams, settleParams, takeParams]]
  );

  const data = encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: "execute",
    args: ["0x0a10", [permitInput, v4SwapInput], BigInt(Math.floor(Date.now() / 1000) + 300)],
  });

  return { to: getAddress(HOOK_ROUTER), data, value: "0" };
}
