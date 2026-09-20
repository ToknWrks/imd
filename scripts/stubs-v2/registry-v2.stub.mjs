
  const store = {};
  export function isV2Record(rec) { return Boolean(rec && rec.schema === 2 && rec.ownerEoa); }
  export function getWalletRecord(addr) { return store[(addr || "").toLowerCase()] ?? null; }
  export function setWalletRecord(addr, rec) {
    const k = (addr || "").toLowerCase();
    const prev = store[k] ?? {};
    if (rec && rec.ownerEoa) {
      store[k] = {
        ...prev, ...rec, schema: 2,
        sessionKeyAddress: rec.sessionKeyAddress ?? prev.sessionKeyAddress ?? null,
        sessionKeyEnc: rec.sessionKeyEnc ?? prev.sessionKeyEnc ?? null,
        createdAt: prev.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } else {
      store[k] = { ...prev, ...rec, createdAt: prev.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
    }
    return true;
  }
  export function listWallets() { return Object.entries(store).map(([connectedWallet, rec]) => ({ connectedWallet, ...rec })); }
  export function __store() { return store; }
