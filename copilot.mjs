/**
 * copilot.mjs — Co-pilot trading mode: the browser wallet signs, the server proposes.
 *
 * When COPILOT_ACTIVE=true, resolveSigner() returns a co-pilot signer instead
 * of the smart-account/legacy backends. Its callContract() does NOT sign:
 * it enqueues a pending sign request, pushes it to every open dashboard tab
 * via SSE, and blocks on a promise until the user approves (the tab sends the
 * tx through window.ethereum and posts back the hash) or the request
 * times out / is declined (the promise rejects — every engine's existing
 * catch already finalizes strategy reservations and writes the error row,
 * so "skip and log" falls out of the existing failure paths for free).
 *
 * Multi-tx flows (token approvals, the V4 pre-wrap path) surface as SEQUENTIAL
 * approval prompts — one per callContract, same revert isolation as today.
 *
 * Security model: no key material ever reaches the server. The calldata shown
 * in the approval modal was built by your own local server from your own
 * strategy settings — but ALWAYS read the decoded summary before approving.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getChain } from "./chains.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(resolve(DATA_DIR, "accumulate.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS copilot_requests (
    id           TEXT PRIMARY KEY,
    chain        TEXT NOT NULL,
    kind         TEXT NOT NULL,               -- 'buy' | 'sell' | 'approve' | 'wrap' | 'other'
    product      TEXT NOT NULL DEFAULT 'other', -- 'dip' | 'sniper' | 'mm' | 'other'
    symbol       TEXT,
    summary      TEXT,                        -- human-readable decoded summary for the modal
    to_address   TEXT NOT NULL,
    value_wei    TEXT NOT NULL DEFAULT '0',   -- decimal string (bigint-safe)
    data         TEXT NOT NULL,               -- 0x-prefixed calldata
    status       TEXT NOT NULL DEFAULT 'pending', -- pending | approved | declined | expired | error
    tx_hash      TEXT,
    error        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at  TEXT
  );
`);

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn("copilot_requests", "user_id", "user_id TEXT"); // owning user (Phase 2 isolation)

// ── SSE clients (dashboard tabs) ─────────────────────────────────────────────
const sseClients = new Set();

export function addSseClient(res) {
  sseClients.add(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ pending: listPending().length })}\n\n`);
  return () => sseClients.delete(res);
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ── Waiting callContract promises, keyed by request id ──────────────────────
const waiters = new Map(); // id -> { resolve, reject, timer }

export function isCopilotActive() {
  return process.env.COPILOT_ACTIVE === "true";
}

export function copilotTimeoutMs() {
  return Math.max(10, Number(process.env.COPILOT_TIMEOUT_S ?? 90)) * 1000;
}

function expire(id, status, error) {
  const w = waiters.get(id);
  if (w) {
    clearTimeout(w.timer);
    waiters.delete(id);
    w.reject(new Error(error));
  }
  db.prepare(`UPDATE copilot_requests SET status = ?, error = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'pending'`)
    .run(status, error, id);
  broadcast("resolved", { id, status });
}

// Expire stale pending rows on startup (a restart orphans waiters by design —
// "broken" and "never ran" must be distinguishable, so mark them, don't delete).
const stale = db.prepare(`SELECT id FROM copilot_requests WHERE status = 'pending'`).all();
for (const row of stale) {
  db.prepare(`UPDATE copilot_requests SET status = 'expired', error = 'server restarted while awaiting approval', resolved_at = datetime('now') WHERE id = ?`).run(row.id);
}

// Periodic sweep in case a timer is lost (process hiccup, clock edge).
setInterval(() => {
  const cutoff = copilotTimeoutMs();
  for (const [id, w] of waiters) {
    if (Date.now() - w.createdAt >= cutoff) expire(id, "expired", `no approval within ${cutoff / 1000}s — trade skipped (never trades without explicit approval)`);
  }
}, 5000).unref();

// ── Request lifecycle ────────────────────────────────────────────────────────

export function listPending() {
  return db.prepare(`SELECT * FROM copilot_requests WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

export function listRecent(limit = 30) {
  return db.prepare(`SELECT * FROM copilot_requests ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit);
}

export function getRequest(id) {
  return db.prepare(`SELECT * FROM copilot_requests WHERE id = ?`).get(id);
}

/**
 * Create a pending request and wait for the user's browser signature.
 * Resolves to the tx hash; rejects on decline/timeout/server shutdown.
 */
function awaitBrowserSignature({ chain, kind, product, symbol, summary, to, value, data, userId = null }) {
  const id = `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const dep = getChain(chain);
  const timeoutMs = copilotTimeoutMs();

  db.prepare(`
    INSERT INTO copilot_requests (id, chain, kind, product, symbol, summary, to_address, value_wei, data, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, chain, kind, product, symbol ?? null, summary ?? null, to, value.toString(), data, userId);

  const payload = {
    id, chain, chainId: dep.viemChain.id, chainName: dep.name,
    kind, product, symbol: symbol ?? null, summary: summary ?? null,
    to, value: value.toString(), data,
    expiresAt: Date.now() + timeoutMs,
  };
  broadcast("request", payload);
  console.log(`[copilot] ⏳ ${product}/${kind} request ${id} on ${dep.name} — awaiting browser approval (${timeoutMs / 1000}s)`);

  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => expire(id, "expired", `no approval within ${timeoutMs / 1000}s — trade skipped (never trades without explicit approval)`),
      timeoutMs,
    );
    waiters.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, createdAt: Date.now() });
  });
}

/** Browser approved + broadcast the tx — settle the waiter. */
export function resolveRequest(id, txHash, resolvedBy = null) {
  const row = getRequest(id);
  if (!row || row.status !== "pending") return { ok: false, error: "request not pending" };
  // Isolation: only the owning user's session may resolve (another user's
  // browser session can't approve someone else's trade).
  if (row.user_id && resolvedBy && String(resolvedBy).toLowerCase() !== String(row.user_id).toLowerCase()) {
    return { ok: false, error: "not your sign request" };
  }
  const w = waiters.get(id);
  if (!w) return { ok: false, error: "no waiter (server restarted?)" };
  clearTimeout(w.timer);
  waiters.delete(id);
  db.prepare(`UPDATE copilot_requests SET status = 'approved', tx_hash = ?, resolved_at = datetime('now') WHERE id = ?`).run(txHash, id);
  w.resolve(txHash);
  broadcast("resolved", { id, status: "approved", txHash });
  console.log(`[copilot] ✅ request ${id} approved — tx ${txHash}`);
  return { ok: true };
}

/** Browser (or API) declined — reject so the engine's catch logs the skip. */
export function declineRequest(id, reason = "declined by user in browser", declinedBy = null) {
  const row = getRequest(id);
  if (!row || row.status !== "pending") return { ok: false, error: "request not pending" };
  if (row.user_id && declinedBy && String(declinedBy).toLowerCase() !== String(row.user_id).toLowerCase()) {
    return { ok: false, error: "not your sign request" };
  }
  expire(id, "declined", reason);
  console.log(`[copilot] 🚫 request ${id} declined`);
  return { ok: true };
}

// ── The signer backend ───────────────────────────────────────────────────────

const _copilotSigners = new Map();

/**
 * Build the co-pilot signer for a chain. Same interface as every other
 * backend: { kind, address, getEthBalanceWei(), callContract(...) → txHash }.
 * `address` is the CONNECTED wallet (the signer of record) — reads that use
 * signer.address stay correct.
 */
export async function buildCoPilotSigner(chainKey = "ethereum") {
  // Legacy/system co-pilot signer — signs for the CONNECTED_WALLET env user.
  // Multi-user callers use buildCoPilotSignerFor(userId, chainKey) instead.
  const connected = process.env.CONNECTED_WALLET;
  return buildCoPilotSignerFor(connected, chainKey);
}

/**
 * Per-user co-pilot signer (Phase 2): sign requests are stamped user_id so the
 * dashboard only surfaces THIS user's approvals, and the queued request can't
 * be resolved by another user's browser session.
 */
export async function buildCoPilotSignerFor(userId, chainKey = "ethereum") {
  if (!userId) throw new Error("co-pilot signer needs a user id (the connected wallet address)");
  const cacheKey = `${userId}:${chainKey}`;
  if (_copilotSigners.has(cacheKey)) return _copilotSigners.get(cacheKey);
  const p = (async () => {
    const dep = getChain(chainKey);
    const connected = userId.toLowerCase();
    if (!connected) throw new Error("Co-pilot mode needs a connected wallet — click Connect wallet in the header first");
    const { createPublicClient, http, encodeFunctionData } = await import("viem");
    const publicClient = createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc()) });

    const signer = {
      kind: "copilot",
      address: connected,
      async getEthBalanceWei() {
        return publicClient.getBalance({ address: connected });
      },
      /**
       * Enqueue the tx for browser approval and block until the user signs.
       * Summary text: callers pass an optional opts.copilot = { kind, product, symbol, summary };
       * default summary carries the essentials (to + value + selector).
       */
      async callContract({ address: contractAddress, abi, functionName, args, value, maxFeePerGas, maxPriorityFeePerGas, copilot }) {
        // UO gas fields are ignored here too — the browser wallet estimates gas.
        void maxFeePerGas; void maxPriorityFeePerGas;
        const data = encodeFunctionData({ abi, functionName, args: args ?? [] });
        const sel = data.slice(0, 10);
        const eth = value ? Number(value) / 1e18 : 0;
        const summary = copilot?.summary
          ?? `${copilot?.kind ?? "call"} ${functionName ?? sel} → ${contractAddress}${eth ? ` · ${eth.toFixed(6)} ETH` : ""}`;
        return awaitBrowserSignature({
          chain: chainKey,
          kind: copilot?.kind ?? (functionName === "approve" ? "approve" : eth > 0n ? "buy" : "other"),
          product: copilot?.product ?? "other",
          symbol: copilot?.symbol ?? null,
          summary,
          to: contractAddress,
          value: value ?? 0n,
          data,
          userId,
        });
      },
    };
    console.log(`[copilot] signer active on ${dep.name} — trades wait for browser approval from ${connected}`);
    return signer;
  })();
  _copilotSigners.set(cacheKey, p);
  return p;
}

/** Drop cached co-pilot signers (mode toggle / connected-wallet change). */
export function invalidateCoPilotSigners() {
  _copilotSigners.clear();
}

/** True when any co-pilot request is awaiting a signature (header badge). */
export function pendingCount() {
  return listPending().length;
}
