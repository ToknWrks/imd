
    import { privateKeyToAccount } from "viem/accounts";
    // A deterministic session key; the test expects its EOA as owner.
    const SK = "0x" + "1".repeat(64);
    export function isV2Record() { return false; }
    export function getWalletRecord() {
      return {
        scwAddress: "0x" + "9".repeat(40),
        sessionKeyAddress: privateKeyToAccount(SK).address,
        sessionKeyEnc: "enc:" + SK,
      };
    }
    export function setWalletRecord() {}
  