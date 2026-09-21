/**
 * Launchpad-token transferability probe (2026-09-21).
 *
 * Launchpad curve coins keep balances in the HOOK's ledger — raw ERC-20
 * `_balances` can be ZERO while balanceOf() reports the curve position.
 * Every transfer/transferFrom then panics 0x11 and the UR surfaces it as
 * TRANSFER_FROM_FAILED: the app's sell route CANNOT move curve-position
 * coins, only coins that physically landed in the wallet map (e.g. via a
 * UR swap settle).
 *
 * probeRawBalance(token, owner): reads raw storage slot
 *   keccak256(owner ++ 0) — the standard ERC-20 `_balances` mapping slot —
 * and returns the RAW stored balance. If it's 0 while balanceOf > 0, the
 * coins are curve-native and sells must go through the launchpad UI.
 */
import { keccak256, toHex, parseAbi } from "viem";

export async function probeRawErc20Balance(token, owner, chainKey = "ethereum") {
  const pub = (await import("./sniper-swap.mjs")).publicClient(chainKey);
  const slot = keccak256(toHex(owner.slice(2).toLowerCase().padStart(64, "0") + "0".repeat(64), { allowModulo: true }));
  const raw = await pub.getStorageAt({ address: token, slot });
  return BigInt(raw);
}

/** True when the wallet's transferable (raw-stored) balance covers `amountWei`. */
export async function canTransferErc20(token, owner, amountWei, chainKey = "ethereum") {
  const raw = await probeRawErc20Balance(token, owner, chainKey);
  return raw >= amountWei;
}

export const LAUNCHPAD_TOKEN_URL = (addr) => `https://communitycoins.imd.fun/token/${addr}`;
