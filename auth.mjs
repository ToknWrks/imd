/**
 * auth.mjs — wallet-signature authentication for the dashboard (SIWE-style).
 *
 * The ONLY way in: connect your browser wallet and sign a one-time nonce.
 * No password exists anywhere — nothing to leak, phish, or share. The session
 * cookie is bound to the wallet address and expires after 12h.
 *
 * Flow: page (unauthed) → login page with Connect button → /api/auth/nonce →
 * personal_sign(message) in the wallet → POST /api/auth/verify {address,
 * signature, nonce} → server recovers the signer (viem verifyMessage) →
 * HMAC-signed HttpOnly cookie. Every subsequent request is checked by cookie.
 *
 * Access control: ALLOWED_WALLET in .env pins the single authorized address.
 * Falls back to CONNECTED_WALLET (the header connect-wallet address). If
 * neither is set, ANY wallet can log in — a console warning fires at first
 * login; set ALLOWED_WALLET before hosting.
 *
 * Nonces are single-use, 5-minute TTL, in-memory (a restart invalidates
 * pending logins — harmless, just click connect again).
 */

import { createHmac, timingSafeEqual, randomBytes } from "crypto";
import { verifyMessage } from "viem";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const NONCE_TTL_MS = 5 * 60 * 1000;
const VERIFY_MAX_ATTEMPTS = 10;         // per IP per 15 min (signature forgery blunting)
const VERIFY_WINDOW_MS = 15 * 60 * 1000;
const COOKIE_NAME = "imd_session";

function envValue(key) {
  if (process.env[key] !== undefined && process.env[key] !== "") return process.env[key];
  try {
    return readEnvLine(key);
  } catch { return ""; }
}

import { readFileSync } from "fs";
function readEnvLine(key) {
  const m = readFileSync(new URL("./.env", import.meta.url), "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m?.[1]?.trim() ?? "";
}

/**
 * Legacy single-user pin. ONLY ALLOWED_WALLET is honored — the CONNECTED_WALLET
 * fallback is gone (Phase 2): on the hosted multi-user app, CONNECTED_WALLET is
 * just "the wallet some user connected in a browser" and pinning login to it
 * blocked everyone else from registering. Registration (users table +
 * REGISTRATION mode) governs access now; set ALLOWED_WALLET only if you want
 * to hard-pin the door to one wallet.
 */
export function allowedWallet() {
  return envValue("ALLOWED_WALLET").toLowerCase() || null;
}

// ── Session token: <issuedMs>.<addr>.<hmac(issued|addr|ttl)> ─────────────────
const _secretCache = { v: null };
function sessionSecret() {
  if (!_secretCache.v) {
    // Secret derived from the allowed wallet + a random per-process salt. A
    // restart logs everyone out (fine — reconnect is one click).
    _secretCache.v = createHmac("sha256", `imd-auth-v1:${allowedWallet() ?? "any"}`)
      .update(randomBytes(32)).digest();
  }
  return _secretCache.v;
}

function sign(issuedMs, addr) {
  return createHmac("sha256", sessionSecret()).update(`${issuedMs}:${addr}:${SESSION_TTL_MS}`).digest("base64url");
}

export function issueSessionToken(addr) {
  const issued = Date.now().toString();
  return `${issued}.${addr}.${sign(issued, addr)}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [issued, addr, mac] = parts;
  if (!/^\d{13,}$/.test(issued)) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
  const a = Buffer.from(mac), b = Buffer.from(sign(issued, addr));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Date.now() - Number(issued) > SESSION_TTL_MS) return null;
  return addr.toLowerCase(); // authenticated identity
}

function parseCookies(req) {
  const header = req.headers.cookie ?? "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** The authenticated address for a request, or null. */
export function sessionAddress(req) {
  return verifySessionToken(parseCookies(req)[COOKIE_NAME]);
}

export function isAuthed(req) {
  return sessionAddress(req) !== null;
}

export function sessionCookieHeader(addr) {
  const token = issueSessionToken(addr);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ── Nonces (single-use, 5-min TTL) ───────────────────────────────────────────
const _nonces = new Map(); // nonce -> { expiresAt, issuedAt }
export function issueNonce() {
  const nonce = randomBytes(16).toString("hex");
  // The issued timestamp is CAPTURED at issue time and stored with the nonce —
  // loginMessage must be byte-identical at /verify time or every signature
  // fails (a fresh new Date() per call broke the first E2E attempt).
  _nonces.set(nonce, { expiresAt: Date.now() + NONCE_TTL_MS, issuedAt: new Date().toISOString() });
  // opportunistic sweep
  for (const [n, rec] of _nonces) if (Date.now() > rec.expiresAt) _nonces.delete(n);
  return nonce;
}
function consumeNonce(nonce) {
  const rec = _nonces.get(nonce);
  if (!rec || Date.now() > rec.expiresAt) return null;
  _nonces.delete(nonce); // single-use
  return rec; // { issuedAt } — consumed with its captured timestamp
}

function loginMessage(nonce, issuedAt, origin = "localhost") {
  return [
    "Accumulate IMD wants you to sign in.",
    "",
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
    `Domain: ${origin}`,
    "",
    "This signature only proves wallet ownership for dashboard login.",
    "It authorizes NO transactions and moves NO funds.",
  ].join("\n");
}

// ── Rate limiting on verify (per IP) ─────────────────────────────────────────
const _verifyAttempts = new Map();
function ipOf(req) {
  return (req.socket?.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}
function verifyBlocked(req) {
  const now = Date.now();
  const arr = (_verifyAttempts.get(ipOf(req)) ?? []).filter((t) => now - t < VERIFY_WINDOW_MS);
  _verifyAttempts.set(ipOf(req), arr);
  return arr.length >= VERIFY_MAX_ATTEMPTS;
}

/**
 * Verify a login attempt: { address, signature, nonce }.
 * Returns { ok, address } or { ok:false, error }.
 */
export async function verifyLogin({ address, signature, nonce }, req) {
  if (verifyBlocked(req)) return { ok: false, error: "Too many attempts — wait 15 minutes" };
  const fail = (error) => {
    const arr = _verifyAttempts.get(ipOf(req)) ?? [];
    arr.push(Date.now());
    _verifyAttempts.set(ipOf(req), arr);
    return { ok: false, error };
  };
  if (!address || !signature || !nonce) return fail("missing address/signature/nonce");
  const addr = String(address).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return { ok: false, error: "invalid address" };
  const nonceRec = consumeNonce(String(nonce));
  if (!nonceRec) return { ok: false, error: "nonce expired or already used — reconnect and try again" };
  // Multi-user registration gate (Phase 2): REGISTRATION env controls who may
  // create an account. "open" (default) = any valid wallet registers itself;
  // "closed" = only wallets already in the users table may sign in.
  // ALLOWED_WALLET, when set, acts as an allowlist that overrides registration
  // mode (legacy single-user pin — still honored if present).
  const allowed = allowedWallet();
  if (allowed && addr !== allowed) {
    return { ok: false, error: `wallet ${addr.slice(0, 6)}…${addr.slice(-4)} is not the authorized wallet for this dashboard` };
  }
  try {
    const rebuilt = loginMessage(nonce, nonceRec.issuedAt);
    const valid = await verifyMessage({ address, message: rebuilt, signature });
    if (!valid) return fail("signature does not match address — login rejected");
  } catch (e) {
    return fail("signature verification failed — login rejected");
  }
  // Registration: auto-create the user row on first sign-in (open mode), or
  // require an existing row (closed mode). Disabled accounts are locked out.
  const { registerUser, isUserDisabled } = await import("./users.mjs");
  const user = registrationMode() === "closed" ? (await import("./users.mjs")).getUser(addr) : registerUser(addr);
  if (!user) {
    return { ok: false, error: `wallet ${addr.slice(0, 6)}…${addr.slice(-4)} has no account — registration is closed. Ask an admin to add you.` };
  }
  if (isUserDisabled(addr)) {
    return { ok: false, error: "this account has been disabled by an admin" };
  }
  _verifyAttempts.delete(ipOf(req));
  console.log(`[auth] ✅ wallet ${addr.slice(0, 6)}…${addr.slice(-4)} signed in${user.is_admin ? " (admin)" : ""}`);
  // Ensure this wallet's per-user session key + smart wallet exist (Option 1,
  // 2026-09-18): login IS the connect action now — there is no separate
  // "Connect wallet" step, so this is the one place that must call it.
  // Best-effort: a failure here must not block sign-in (co-pilot users never
  // need a session key at all).
  try {
    const { ensureWalletSession } = await import("./smart-wallet-api.mjs");
    await ensureWalletSession(addr, "ethereum");
  } catch (e) { console.error(`[auth] wallet session ensure failed for ${addr.slice(0, 6)}…${addr.slice(-4)}:`, e.message); }
  return { ok: true, address: addr };
}

function registrationMode() {
  return (process.env.REGISTRATION || envValue("REGISTRATION") || "open").toLowerCase() === "closed" ? "closed" : "open";
}

// ── Unauthenticated placeholder (rendered inside the normal shell — 2026-09-19) ──
// There is no separate login page/document anymore: signing in IS the header
// "Connect wallet" button (wallet-connect.js performs connect + nonce + sign +
// verify in one flow). An unauthenticated page request gets the exact same
// header/nav/chrome as everyone else, with this in the content area instead
// of real (per-user) data — never the standalone-doc gate the app used to
// swap in, and never another user's data (getDipWatchers(null) etc. return
// an all-users legacy view, so this placeholder is also a safety boundary).
const CONNECT_PROMPT_BODY = `
  <div class="card" style="max-width:420px;margin:3rem auto;text-align:center">
    <h2 style="margin-top:0">Connect your wallet</h2>
    <p class="hint">Click <strong>Connect wallet</strong> in the header and sign the login message to continue.<br>The signature proves ownership only — it never moves funds.</p>
  </div>`;

/**
 * The gate. Call FIRST in the request handler; returns true when the request
 * was fully handled (placeholder page / 401 JSON / auth endpoint) and the
 * caller must `return;`. Returns false to proceed with normal routing.
 */
export async function handleAuth(req, res, { url, method, readBody, json, send, shell }) {
  // Auth endpoints are always reachable (login chicken-and-egg).
  if (url === "/api/auth/nonce" && method === "GET") {
    const nonce = issueNonce();
    const rec = _nonces.get(nonce);
    const addr = allowedWallet();
    json({ ok: true, nonce, message: loginMessage(nonce, rec.issuedAt) });
    return true;
  }
  if (url === "/api/auth/verify" && method === "POST") {
    readBody().then(async (body) => {
      try {
        const result = await verifyLogin(JSON.parse(body || "{}"), req);
        if (result.ok) res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader(result.address) });
        else res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return true;
  }
  if (url === "/auth/logout" && method === "POST") {
    res.writeHead(302, { "Set-Cookie": clearCookieHeader(), Location: "/" });
    res.end();
    return true;
  }

  if (isAuthed(req)) return false;

  // Unauthenticated: API/SSE get 401 JSON; pages get the normal shell with a
  // connect-prompt body — the header's Connect-wallet button IS the sign-in
  // flow (no separate gate document).
  if (url.startsWith("/api/")) {
    json({ ok: false, error: "authentication required" }, 401);
    return true;
  }
  send(shell("Sign in", CONNECT_PROMPT_BODY));
  return true;
}
