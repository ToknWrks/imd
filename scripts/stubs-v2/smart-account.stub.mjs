
  export const gasReserveWei = () => 0n;
  export function invalidateSmartAccountClient() {}
  export function explainUserOpError(e) { return String(e); }
  export const MAV2_FACTORY = "0x" + "1".repeat(40);
  export const SMAV2_IMPL = "0x" + "2".repeat(40);
  export const ENTRY_POINT_V7 = "0x" + "3".repeat(40);
  export function predictEoaOwnedScwAddress(chainKey, eoa) { return "0x" + "d".repeat(40); }
  export function ssvModuleAddress() { return "0x" + "e".repeat(40); }
  export function userOpDigest() { return "0x" + "f".repeat(64); }
  export function packUOSignature(sig) { return "0xFF00" + sig; }
  export async function getSmartAccountClient(chainKey = "ethereum", opts = {}) {
    return { account: { address: "0x" + "9".repeat(40), owner: undefined } };
  }
