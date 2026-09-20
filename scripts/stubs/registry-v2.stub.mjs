
    import { privateKeyToAccount } from "viem/accounts";
    const SK = "0x" + "1".repeat(64);
    // v1 record preloaded for the activate test's probe user.
    const store = {
      "0x2222222222222222222222222222222222222222": {
        scwAddress: "0x9999999999999999999999999999999999999999",
        sessionKeyAddress: privateKeyToAccount(SK).address,
        sessionKeyEnc: "enc:" + SK,
      },
    };
    export function isV2Record(rec) { return Boolean(rec && rec.schema === 2 && rec.ownerEoa); }
    export function getWalletRecord(addr) { return store[(addr || "").toLowerCase()] ?? null; }
    export function setWalletRecord(addr, rec) {
      const k = (addr || "").toLowerCase();
      const prev = store[k] ?? {};
      if (rec && rec.ownerEoa) {
        store[k] = { ...prev, ...rec, schema: 2, sessionKeyAddress: rec.sessionKeyAddress ?? prev.sessionKeyAddress ?? null, sessionKeyEnc: rec.sessionKeyEnc ?? prev.sessionKeyEnc ?? null, createdAt: prev.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
      } else {
        store[k] = { ...prev, ...rec, createdAt: prev.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
      }
      return true;
    }
    export function listWallets() { return Object.entries(store).map(([connectedWallet, rec]) => ({ connectedWallet, ...rec })); }
    export function __store() { return store; }
  