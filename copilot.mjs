/**
 * copilot.mjs — Co-pilot trading mode: the browser wallet signs, the server proposes.
 *
 * When COPILOT_ACTIVE=true (or a user's signer_mode is 'copilot'),
 * resolveSignerUser() returns a co-pilot signer instead of the
 * smart-account/legacy backends. Its callContract() does NOT sign:
 * it enqueues a pending sign request and BLOCKS BY POLLING THE SHARED ROW
 * until the user approves (the tab sends the tx through window.ethereum and
 * posts back the hash) or the request times out / is declined (the promise
 * rejects — every engine's existing catch already finalizes strategy
 * reservations and writes the error row, so "skip and log" falls out of the
 * existing failure paths for free).
 *
 * CROSS-PROCESS (2026-09-22): the engine that enqueues (imd-watcher daemon)
 * and the HTTP layer that receives approve/decline (imd-dashboard) are
 * different processes. Settlement is the shared SQLite row — resolveRequest()
 * writes it, the engine's awaitRequestResolution() poll reads it. No in-memory
 * waiter, so approval works no matter which process the engine lives in.
 *
 * Multi-tx flows (token approvals, the V4 pre-wrap path) surface as SEQUENTIAL
 * approval prompts — one per callContract, same revert isolation as today.
 *
 * Security model: no key material ever reaches the server. The calldata shown
 * in the approval panel was built by your own local server from your own
 * strategy settings — but ALWAYS read the decoded summary before approving.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { AsyncLocalStorage } from "node:async_hooks";
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
    resolved_at  TEXT,
    expires_at   TEXT                         -- absolute UTC deadline (cross-process expiry)
  );
`);

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn("copilot_requests", "user_id", "user_id TEXT"); // owning user (Phase 2 isolation)
ensureColumn("copilot_requests", "expires_at", "TEXT"); // absolute UTC deadline (cross-process expiry)

// ── Request attribution context (2026-09-22) ─────────────────────────────────
// Engines call buyToken() → sendV4Buy() → callContract() many layers deep —
// threading { product, symbol, kind, summary } through every signature would
 // touch a dozen functions. Instead an engine sets the context around its
 // trade call (withCopilotContext) and callContract merges it in. ALS is
 // async-aware, so awaits inside buyToken keep the context.
const _cpContext = new AsyncLocalStorage();

/**
 * Run `fn` with co-pilot attribution attached to every sign request it
 * enqueues. Engine call sites: dip-watcher buy paths, mm legs, autosell.
 * { product, symbol, kind, summary, timeoutS } — each optional; explicit
 * opts.copilot on a callContract call still wins over the context.
 */
export function withCopilotContext(meta, fn) {
  return _cpContext.run(meta ?? {}, fn);
}

/** Merge: explicit copilot opts > ALS context > defaults. */
function attribution({ product, kind, symbol, summary, timeoutS } = {}) {
  const ctx = _cpContext.getStore() ?? {};
  const merged = {
    product: product ?? ctx.product ?? "other",
    kind,
    symbol: symbol ?? ctx.symbol ?? null,
    summary,
    timeoutS: timeoutS ?? ctx.timeoutS ?? null,
  };
  // Default summary when NEITHER layer provided one: callContract builds its
  // selector-based fallback; only fill in a context-level summary here.
  if (!merged.summary && ctx.summary) merged.summary = ctx.summary;
  return merged;
}

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

// ── Cross-process SSE bridge (2026-09-22) ────────────────────────────────────
// broadcast() only reaches tabs connected to THIS process. When the engine
// that enqueues a request lives in imd-watcher, its broadcast lands nowhere —
// the dashboard process holds the SSE connections but never learns a request
// appeared, so tabs got no toast and the badge stayed stale until reload
// (found live: user logged in, watching the page, saw nothing). Fix: poll the
// shared table here in whatever process holds SSE clients and push the
// diffs. Rows this process enqueued itself were already broadcast() — the
// _cpAnnounced set dedupes those so tabs don't see a request twice.
const _cpAnnounced = new Set();

function diffAndBroadcastCopilotRows() {
  try {
    const rows = db.prepare(`SELECT * FROM copilot_requests WHERE status IN ('pending','expired','declined') AND created_at > datetime('now', '-1 hour') ORDER BY created_at ASC`).all();
    for (const row of rows) {
      if (_cpAnnounced.has(row.id)) continue;
      _cpAnnounced.add(row.id);
      if (row.status === "pending") {
        broadcast("request", {
          id: row.id, chain: row.chain, kind: row.kind, product: row.product,
          symbol: row.symbol, summary: row.summary, to: row.to_address,
          value: row.value_wei ?? "0", data: row.data,
          expiresAt: row.expires_at ? Date.parse(row.expires_at + "Z") : Date.now() + copilotTimeoutMs(),
        });
      } else {
        // Expired/declined rows the user never signed — surfaced so the UI
        // can say "this trade was skipped", not just silently drop the badge.
        broadcast("skipped", { id: row.id, status: row.status, symbol: row.symbol, product: row.product, error: row.error });
      }
    }
    // Keep the dedupe set bounded (last hour is plenty).
    if (_cpAnnounced.size > 500) {
      const cutoff = Date.now() - 60 * 60_000;
      for (const id of _cpAnnounced) {
        const r = getRequest(id);
        if (!r || Date.parse(r.created_at + "Z") < cutoff) _cpAnnounced.delete(id);
      }
    }
  } catch (e) {
    console.error("[copilot] SSE bridge poll failed:", e.message);
  }
}

// Only run the bridge in processes that actually hold SSE clients — in the
// watcher process the client set is empty and the poll is wasted work.
setInterval(() => { if (sseClients.size > 0) diffAndBroadcastCopilotRows(); }, 3000).unref();

// ── Engine wait: DB-poll based (cross-process, 2026-09-22) ──────────────────
// The engine that enqueues a request (imd-watcher, dashboard's autosell loop,
// mm) may live in a DIFFERENT process from the dashboard that receives the
// approve/decline POSTs. An in-memory waiter map only exists in the enqueuing
// process, so on hosted the dashboard's resolve POST found no waiter and
// rejected the hash ("server rejected the hash") while the trade mined
// on-chain — every engine-initiated co-pilot buy failed to settle (found live
// 2026-09-22, IMD scheduled buy). The shared SQLite row is the only contract
// both sides see: the engine polls its row for a terminal status instead of
// blocking on a promise.

export function isCopilotActive() {
  return process.env.COPILOT_ACTIVE === "true";
}

/**
 * Approval window in ms. Engine trades wait on a human, and the wait must
 * outlive a tab left in the background — 90s was tuned for "you just clicked
 * buy". Dip buys fire on the market's schedule, not the user's, so they get a
 * longer window (5 min) by default. Override per request via
 * opts.copilot.timeoutS; COPILOT_TIMEOUT_S still sets the base window.
 */
export function copilotTimeoutMs({ product = null, kind = null, timeoutS = null } = {}) {
  const base = Math.max(10, Number(process.env.COPILOT_TIMEOUT_S ?? 90));
  const seconds = timeoutS ?? (product === "dip" && (kind === "buy" || kind == null) ? Math.max(base, 300) : base);
  return Math.max(10, seconds) * 1000;
}

/** Terminal status → throw message. Returns the tx hash on approval. */
function settlement(row) {
  if (!row) return { error: "copilot request row disappeared" };
  if (row.status === "approved") return { txHash: row.tx_hash };
  if (row.status === "declined") return { error: row.error || "declined by user in browser" };
  if (row.status === "expired") return { error: row.error || "no approval within the window — trade skipped (never trades without explicit approval)" };
  if (row.status === "error") return { error: row.error || "request errored" };
  return null; // still pending
}

/**
 * Poll the request row until a terminal status lands (from ANY process —
 * the dashboard writes approve/decline, the sweep writes expired). Resolves
 * to the browser tx hash on approval; rejects on decline/timeout. Every
 * engine's existing catch already finalizes reservations + writes the error
 * row, so "skip and log" falls out of the existing failure paths.
 */
export async function awaitRequestResolution(id, { pollMs = 2000, maxMs = 15 * 60_000 } = {}) {
  const start = Date.now();
  for (;;) {
    const row = getRequest(id);
    const s = settlement(row);
    if (s && s.txHash !== undefined) return s.txHash;
    if (s && s.error) throw new Error(s.error);
    // Hard backstop independent of expires_at: a clock edge or a missing
    // expires_at column must never hang an engine forever.
    if (Date.now() - start > maxMs) {
      expire(id, "expired", "no approval within the window — trade skipped (never trades without explicit approval)");
      throw new Error("no approval within the window — trade skipped (never trades without explicit approval)");
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Mark a pending request terminal (any process may expire its own sweep). */
function expire(id, status, error) {
  db.prepare(`UPDATE copilot_requests SET status = ?, error = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'pending'`)
    .run(status, error, id);
  broadcast("resolved", { id, status });
}

// Periodic sweep: expire pending rows past their expires_at. Runs in EVERY
// process that imports copilot.mjs, so expiry happens even if the enqueuing
// engine is the only one alive. (This replaced the old startup sweep that
// expired ALL pending rows on import — with cross-process requests, one
// process restarting must not kill another process's live request.)
setInterval(() => {
  try {
    const stale = db.prepare(`SELECT id FROM copilot_requests WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= datetime('now')`).all();
    for (const row of stale) {
      expire(row.id, "expired", "no approval within the window — trade skipped (never trades without explicit approval)");
    }
  } catch {}
}, 5000).unref();

// ── Request lifecycle ────────────────────────────────────────────────────────

export function listPending() {
  // Normalized shape (2026-09-20): map DB columns to the SAME field names the
  // SSE 'request' event uses (to/value/expiresAt). The pending-restore path
  // (page reload with requests still waiting) fed raw rows to cpApprove,
  // which read req.to === undefined → the wallet threw
  // "Cannot read properties of undefined (reading 'toLowerCase')".
  return db.prepare(`SELECT * FROM copilot_requests WHERE status = 'pending' ORDER BY created_at ASC`).all()
    .map((r) => ({
      ...r,
      to: r.to_address,
      value: r.value_wei ?? "0",
      // created_at is a UTC SQLite timestamp; convert to epoch ms for the
      // countdown. Deadline = the row's own expires_at (set at enqueue time,
      // so a per-product longer window survives a page reload); fall back to
      // created_at + base window for rows created before that column existed.
      expiresAt: r.expires_at
        ? Date.parse(r.expires_at + "Z")
        : Date.parse(r.created_at + "Z") + copilotTimeoutMs(),
    }));
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
 * Cross-process safe (2026-09-22): the engine may live in imd-watcher while
 * approve/decline land via the dashboard process — settlement is read back
 * from the shared SQLite row, never from an in-memory waiter.
 */
function awaitBrowserSignature({ chain, kind, product, symbol, summary, to, value, data, userId = null, timeoutS = null }) {
  const id = `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const dep = getChain(chain);
  const timeoutMs = copilotTimeoutMs({ product, kind, timeoutS });

  db.prepare(`
    INSERT INTO copilot_requests (id, chain, kind, product, symbol, summary, to_address, value_wei, data, user_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'))
  `).run(id, chain, kind, product, symbol ?? null, summary ?? null, to, value.toString(), data, userId, Math.round(timeoutMs / 1000));

  const payload = {
    id, chain, chainId: dep.viemChain.id, chainName: dep.name,
    kind, product, symbol: symbol ?? null, summary: summary ?? null,
    to, value: value.toString(), data,
    expiresAt: Date.now() + timeoutMs,
  };
  broadcast("request", payload);
  console.log(`[copilot] ⏳ ${product}/${kind} request ${id} on ${dep.name} — awaiting browser approval (${timeoutMs / 1000}s)`);

  return awaitRequestResolution(id);
}

/** Browser approved + broadcast the tx — settle the request (any process). */
export function resolveRequest(id, txHash, resolvedBy = null) {
  const row = getRequest(id);
  if (!row || row.status !== "pending") return { ok: false, error: "request not pending" };
  // Isolation: only the owning user's session may resolve (another user's
  // browser session can't approve someone else's trade).
  if (row.user_id && resolvedBy && String(resolvedBy).toLowerCase() !== String(row.user_id).toLowerCase()) {
    return { ok: false, error: "not your sign request" };
  }
  db.prepare(`UPDATE copilot_requests SET status = 'approved', tx_hash = ?, resolved_at = datetime('now') WHERE id = ?`).run(txHash, id);
  broadcast("resolved", { id, status: "approved", txHash });
  console.log(`[copilot] ✅ request ${id} approved — tx ${txHash} (engine picks it up via the shared row)`);
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
        const attr = attribution(copilot);
        const summary = attr.summary
          ?? `${attr.kind ?? "call"} ${functionName ?? sel} → ${contractAddress}${eth ? ` · ${eth.toFixed(6)} ETH` : ""}`;
        return awaitBrowserSignature({
          chain: chainKey,
          kind: attr.kind ?? (functionName === "approve" ? "approve" : eth > 0n ? "buy" : "other"),
          product: attr.product,
          symbol: attr.symbol,
          summary,
          to: contractAddress,
          value: value ?? 0n,
          data,
          userId,
          timeoutS: attr.timeoutS,
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
