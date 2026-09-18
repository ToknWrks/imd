/**
 * wallet-connect-store.mjs — server-side record of the CONNECTED wallet
 * address (address only, NEVER key material). Persisted to .env as
 * CONNECTED_WALLET so all pages/APIs can resolve "the user's wallet" without
 * any signing capability — the key stays in the browser extension.
 *
 * Resolution order for "the connected wallet" (resolveConnectedWallet):
 *   1. CONNECTED_WALLET env (set by the header Connect button) — highest
 *      precedence when set; this is the host-deployment source of truth.
 *   2. Fallback: the configured signer (vault/raw key) — preserves the
 *      current local behavior during the migration away from VAULT_ACTIVE.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, ".env");

export function getConnectedWallet() {
  try {
    if (!existsSync(ENV_PATH)) return null;
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^CONNECTED_WALLET=(.*)$/);
      if (m) {
        const v = m[1].trim().replace(/^["']|["']$/g, "");
        return v || null;
      }
    }
  } catch {}
  return null;
}

export function setConnectedWallet(address) {
  try {
    let src = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
    const line = address ? `CONNECTED_WALLET=${address}` : "";
    if (/^CONNECTED_WALLET=.*$/m.test(src)) {
      src = address
        ? src.replace(/^CONNECTED_WALLET=.*$/m, line)
        : src.replace(/^CONNECTED_WALLET=.*$\n?/m, "");
    } else if (address) {
      src = src.trimEnd() + "\n" + line + "\n";
    }
    writeFileSync(ENV_PATH, src, "utf8");
    if (address) process.env.CONNECTED_WALLET = address;
    else delete process.env.CONNECTED_WALLET;
  } catch (e) {
    console.error("[wallet-connect] persist failed:", e.message);
  }
}

/** Read-only address of the user's wallet — env first, signer fallback. */
export async function resolveConnectedWalletAddress() {
  const stored = getConnectedWallet();
  if (stored) return stored;
  try {
    const { resolveSigner, invalidateSigner } = await import("./signer.mjs");
    const prev = process.env.SMART_ACCOUNT_ACTIVE;
    process.env.SMART_ACCOUNT_ACTIVE = "false";
    invalidateSigner("ethereum");
    try {
      const signer = await resolveSigner("ethereum");
      return signer.address;
    } finally {
      process.env.SMART_ACCOUNT_ACTIVE = prev;
      invalidateSigner("ethereum");
    }
  } catch {
    return null;
  }
}
