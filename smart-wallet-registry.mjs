/**
 * smart-wallet-registry.mjs — per-connected-wallet smart account registry.
 *
 * Option 1 model (user decision 2026-09-18): EACH connected wallet owns its own
 * smart wallet. Switching the header wallet switches which smart wallet the app
 * displays and uses — funds, positions, and P/L stay isolated per wallet.
 *
 * Registry shape (data/connected-scws.json):
 *   { "0xConnectedWallet": { scwAddress, sessionKeyAddress, createdAt } }
 *
 * Ownership model: the smart account's ON-CHAIN owner is the CONNECTED wallet
 * (that wallet can always recover via addOwner/transferOwnership — standard
 * hosted-trading pattern). The server-side session key is a signer authorized
 * by the connected wallet. For Phase 1 derivation-only (no on-chain delegation
 * yet), the registry records the mapping and the account is derived from the
 * session key issued per connected wallet — so different connected wallets get
 * different SCWs because they each got their own session key.
 *
 * Persistence: data/connected-wallets.json (gitignored data dir, same place the
 * SQLite DB lives). Structure survives restarts; .env stays single-value for
 * the ACTIVE wallet only.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "data");
const REGISTRY_FILE = resolve(DATA_DIR, "connected-wallets.json");

function loadRegistry() {
  try {
    if (!existsSync(REGISTRY_FILE)) return {};
    return JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
  } catch (e) {
    console.error("[wallet-registry] load failed:", e.message);
    return {};
  }
}

function saveRegistry(reg) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = REGISTRY_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(reg, null, 2), "utf8");
    renameSync(tmp, REGISTRY_FILE);
  } catch (e) {
    console.error("[wallet-registry] save failed:", e.message);
  }
}

/** Get (or lazily create) the record for a connected wallet. */
export function getWalletRecord(connectedAddress) {
  if (!connectedAddress) return null;
  const key = connectedAddress.toLowerCase();
  const reg = loadRegistry();
  return reg[key] ?? null;
}

/** Record that a connected wallet now owns the given smart account + session key. */
export function setWalletRecord(connectedAddress, { scwAddress, sessionKeyAddress, sessionKeyEnc }) {
  if (!connectedAddress || !/^0x[0-9a-fA-F]{40}$/.test(connectedAddress)) return false;
  const key = connectedAddress.toLowerCase();
  const reg = loadRegistry();
  reg[key] = {
    scwAddress,
    sessionKeyAddress: sessionKeyAddress ?? null,
    ...(sessionKeyEnc ? { sessionKeyEnc } : {}),
    createdAt: reg[key]?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveRegistry(reg);
  return true;
}

/** List every registered connected wallet → its smart wallet. */
export function listWallets() {
  const reg = loadRegistry();
  return Object.entries(reg).map(([address, rec]) => ({
    connectedWallet: address,
    ...rec,
  }));
}
