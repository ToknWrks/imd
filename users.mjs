/**
 * users.mjs — multi-user registry + settings storage (Phase 2 hosted).
 *
 * Identity = wallet address (proven by SIWE signature in auth.mjs). The first
 * wallet to sign in becomes is_admin=1; every subsequent wallet auto-registers
 * (open registration — any wallet that signs a valid nonce gets an account).
 *
 * Per-user settings live here (signer mode, encrypted secrets). Secret values
 * are AES-256-GCM encrypted with a master key from MASTER_KEY in .env; if
 * MASTER_KEY is unset a random per-process key is used, which means stored
 * secrets DO NOT SURVIVE A RESTART until MASTER_KEY is set — the module logs
 * a loud warning in that state. Never store secrets in plaintext.
 *
 * Roles:
 *   - is_admin=1  → can see the Users admin panel, approve/disable accounts
 *                   (only meaningful if REGISTRATION=approval later; today
 *                   registration is open)
 *   - every user  → isolated watchers/strategies/trades/copilot requests
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(resolve(DATA_DIR, "accumulate.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    wallet_address        TEXT PRIMARY KEY,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    is_admin              INTEGER NOT NULL DEFAULT 0,
    disabled              INTEGER NOT NULL DEFAULT 0,
    display_name          TEXT,
    signer_mode           TEXT NOT NULL DEFAULT 'copilot',  -- 'copilot' | 'autonomy'
    alchemy_key_enc       TEXT,
    session_key_enc       TEXT,
    telegram_bot_enc      TEXT,
    telegram_chat_enc     TEXT,
    low_gas_eth           REAL
  );
`);

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn("users", "signer_mode", "TEXT NOT NULL DEFAULT 'copilot'");
ensureColumn("users", "disabled", "INTEGER NOT NULL DEFAULT 0");

// ── Secret encryption (AES-256-GCM, key from MASTER_KEY env) ────────────────
function masterKey() {
  const explicit = process.env.MASTER_KEY?.trim();
  if (!explicit) {
    // HARD FAIL (2026-09-18 lesson): the old fallback encrypted secrets with a
    // random per-process key — every restart silently destroyed every stored
    // secret (session keys, Alchemy keys), which downstream turned into
    // phantom smart wallets. Refusing to encrypt is the safe failure.
    throw new Error("MASTER_KEY not set — refusing to encrypt user secrets with a per-process random key (they would not survive a restart). Set MASTER_KEY in .env and restart.");
  }
  return createHash("sha256").update(explicit).digest();
}

export function encryptSecret(plain) {
  if (!plain) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored) {
  if (!stored) return null;
  try {
    const [ivB64, tagB64, dataB64] = stored.split(":");
    const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null; // wrong master key / corrupted row
  }
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/** Get a user row (or null). Address is case-normalized. */
export function getUser(walletAddress) {
  if (!walletAddress) return null;
  return db.prepare(`SELECT * FROM users WHERE wallet_address = ?`).get(String(walletAddress).toLowerCase());
}

/** Register (or return existing) user. First-ever user becomes admin. */
export function registerUser(walletAddress) {
  const addr = String(walletAddress).toLowerCase();
  const existing = getUser(addr);
  if (existing) return existing;
  const count = db.prepare(`SELECT COUNT(*) c FROM users`).get().c;
  const isAdmin = count === 0 ? 1 : 0;
  db.prepare(`INSERT INTO users (wallet_address, is_admin) VALUES (?, ?)`).run(addr, isAdmin);
  console.log(`[users] registered ${addr.slice(0, 6)}…${addr.slice(-4)}${isAdmin ? " (admin — first user)" : ""}`);
  return getUser(addr);
}

export function isUserDisabled(walletAddress) {
  const u = getUser(walletAddress);
  return !u || u.disabled === 1;
}

export function listUsers() {
  return db.prepare(`SELECT wallet_address, created_at, is_admin, disabled, display_name, signer_mode FROM users ORDER BY created_at ASC`).all();
}

export function setUserField(walletAddress, field, value) {
  const allowed = ["display_name", "signer_mode", "disabled", "is_admin", "low_gas_eth"];
  if (!allowed.includes(field)) throw new Error(`field ${field} not settable`);
  db.prepare(`UPDATE users SET ${field} = ? WHERE wallet_address = ?`).run(field === "disabled" || field === "is_admin" ? (value ? 1 : 0) : value, String(walletAddress).toLowerCase());
}

// Secret setters/getters (always encrypted at rest)
const SECRET_FIELDS = { alchemy_key_enc: "alchemy", session_key_enc: "session", telegram_bot_enc: "telegram" };

export function setUserSecret(walletAddress, kind, plain) {
  const col = Object.entries(SECRET_FIELDS).find(([, k]) => k === kind)?.[0];
  if (!col) throw new Error(`unknown secret kind: ${kind}`);
  db.prepare(`UPDATE users SET ${col} = ? WHERE wallet_address = ?`).run(encryptSecret(plain), String(walletAddress).toLowerCase());
}

export function getUserSecret(walletAddress, kind) {
  const col = Object.entries(SECRET_FIELDS).find(([, k]) => k === kind)?.[0];
  if (!col) throw new Error(`unknown secret kind: ${kind}`);
  const u = getUser(walletAddress);
  if (!u) return null;
  return decryptSecret(u[col]);
}

export function userCount() {
  return db.prepare(`SELECT COUNT(*) c FROM users`).get().c;
}
