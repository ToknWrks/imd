
    export const gasReserveWei = () => 0n;
    export function invalidateSmartAccountClient() {}
    export function explainUserOpError(e) { return String(e); }
    // PRODUCTION SHAPE: the Alchemy client does NOT expose account.owner
    // (verified live 2026-09-19 — the guard fired on the first activation).
    // The owner must come from the registry session key instead.
    export async function getSmartAccountClient(chainKey = "ethereum", opts = {}) {
      return {
        account: {
          address: "0x" + "9".repeat(40),
          owner: undefined,
        },
        buildUserOperation: async () => ({ preVerificationGas: 0n, verificationGasLimit: 0n, maxFeePerGas: 0n, callGasLimit: 0n }),
        sendUserOperation: async () => ({ hash: "0x" + "f".repeat(64) }),
        waitForUserOperationTransaction: async () => "0x" + "f".repeat(64),
      };
    }
  