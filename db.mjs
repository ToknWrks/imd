/**
 * db.mjs — local SQLite database (dip watchers + trade log).
 * No cloud database required.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(resolve(DATA_DIR, "accumulate.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS dip_watchers (
    id                TEXT PRIMARY KEY,
    chain             TEXT NOT NULL DEFAULT 'ethereum',
    contract_address  TEXT NOT NULL,
    symbol            TEXT,
    decimals          INTEGER NOT NULL DEFAULT 18,
    threshold_usd     REAL NOT NULL,
    buy_amount_usd    REAL NOT NULL,
    slippage_pct      REAL NOT NULL DEFAULT 3,
    cooldown_minutes  INTEGER NOT NULL DEFAULT 15,
    active            INTEGER NOT NULL DEFAULT 1,
    last_triggered_at TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS dip_trades (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    watcher_id     TEXT NOT NULL,
    sell_tx_hash   TEXT,
    sell_usd       REAL,
    buy_tx_hash    TEXT,
    eth_spent      REAL,
    token_amount   REAL,
    price_usd      REAL,
    status         TEXT NOT NULL DEFAULT 'ok',
    error          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS zooch_reviews (
    id                TEXT PRIMARY KEY,
    watcher_id        TEXT NOT NULL,
    contract_address  TEXT NOT NULL,
    symbol            TEXT,
    request_json      TEXT NOT NULL,
    evidence_json     TEXT,
    proposal_json     TEXT,
    narrative_json    TEXT,
    status            TEXT NOT NULL DEFAULT 'queued',
    error             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS accumulation_strategies (
    id                  TEXT PRIMARY KEY,
    watcher_id          TEXT NOT NULL UNIQUE,
    review_id           TEXT NOT NULL,
    profile             TEXT NOT NULL,
    total_budget_usd    REAL NOT NULL,
    deployed_budget_usd REAL NOT NULL DEFAULT 0,
    max_buy_usd         REAL NOT NULL,
    base_buy_usd        REAL NOT NULL,
    dip_buy_usd         REAL NOT NULL,
    dip_threshold_usd   REAL NOT NULL,
    slippage_pct        REAL NOT NULL,
    cooldown_minutes    INTEGER NOT NULL,
    cadence_minutes     INTEGER NOT NULL,
    start_at            TEXT NOT NULL,
    end_at              TEXT NOT NULL,
    next_scheduled_at   TEXT NOT NULL,
    last_scheduled_at   TEXT,
    last_dip_at         TEXT,
    active              INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS strategy_executions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id    TEXT NOT NULL,
    watcher_id     TEXT NOT NULL,
    kind           TEXT NOT NULL,
    amount_usd     REAL NOT NULL,
    scheduled_for  TEXT,
    tx_hash        TEXT,
    status         TEXT NOT NULL,
    error          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

    CREATE TABLE IF NOT EXISTS sniper_trades (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    chain          TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    symbol         TEXT,
    dex            TEXT,
    eth_spent      REAL,
    token_amount   REAL,
    buy_tx_hash    TEXT,
    status         TEXT NOT NULL DEFAULT 'ok',
    error          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

`);

// Wallet position snapshot columns (added via migration so existing DBs pick
// them up without a destructive re-create). Populated by wallet-position.mjs.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn("dip_watchers", "wallet_balance", "wallet_balance REAL");
ensureColumn("dip_watchers", "wallet_balance_usd", "wallet_balance_usd REAL");
ensureColumn("dip_watchers", "price_usd", "price_usd REAL");
ensureColumn("dip_watchers", "cost_basis_usd", "cost_basis_usd REAL");
ensureColumn("dip_watchers", "unrealized_pl_usd", "unrealized_pl_usd REAL");
ensureColumn("dip_watchers", "unrealized_pl_pct", "unrealized_pl_pct REAL");
ensureColumn("dip_watchers", "realized_pl_usd", "realized_pl_usd REAL");
ensureColumn("dip_watchers", "position_updated_at", "position_updated_at TEXT");
ensureColumn("dip_watchers", "position_error", "position_error TEXT");
ensureColumn("dip_watchers", "pool_address", "pool_address TEXT");
ensureColumn("dip_trades", "strategy_id", "strategy_id TEXT");
ensureColumn("dip_trades", "execution_kind", "execution_kind TEXT");
ensureColumn("accumulation_strategies", "reserved_budget_usd", "reserved_budget_usd REAL NOT NULL DEFAULT 0");
ensureColumn("accumulation_strategies", "scheduled_allocation_usd", "scheduled_allocation_usd REAL NOT NULL DEFAULT 0");
ensureColumn("accumulation_strategies", "dip_reserve_usd", "dip_reserve_usd REAL NOT NULL DEFAULT 0");
ensureColumn("zooch_reviews", "chain", "chain TEXT NOT NULL DEFAULT 'ethereum'");
// ETH proceeds captured on sniper sells — enables net cost-basis / realized P/L
// on the Sniper page (buys record eth_spent; sells now record eth_received).
ensureColumn("sniper_trades", "eth_received", "eth_received REAL");

// ── Multi-user isolation (Phase 2): every user-owned table carries user_id.
// Existing rows default to the admin wallet — the first user in `users` (or
// ALLOWED_WALLET/CONNECTED_WALLET when users is empty). New writes stamp the
// session wallet. All dashboard reads scope by it; the watcher copies it from
// the watcher row into trade rows.
import { readFileSync as _rf } from "fs";
function _defaultUserId() {
  try {
    const u = db.prepare(`SELECT wallet_address FROM users ORDER BY is_admin DESC, created_at ASC LIMIT 1`).get();
    if (u) return u.wallet_address;
  } catch {}
  const m = _rf(resolve(__dirname, ".env"), "utf8").match(/^ALLOWED_WALLET=(.*)$/m) || _rf(resolve(__dirname, ".env"), "utf8").match(/^CONNECTED_WALLET=(.*)$/m);
  return m?.[1]?.trim().toLowerCase() ?? null;
}
ensureColumn("dip_watchers", "user_id", "user_id TEXT");
ensureColumn("dip_trades", "user_id", "user_id TEXT");
ensureColumn("accumulation_strategies", "user_id", "user_id TEXT");
ensureColumn("strategy_executions", "user_id", "user_id TEXT");
ensureColumn("sniper_trades", "user_id", "user_id TEXT");
ensureColumn("sniper_recent_tokens", "user_id", "user_id TEXT");
ensureColumn("copilot_requests", "user_id", "user_id TEXT");
ensureColumn("zooch_reviews", "user_id", "user_id TEXT");
ensureColumn("gas_spend", "user_id", "user_id TEXT");
ensureColumn("sniper_autosells", "user_id", "user_id TEXT");

// One-time backfill: rows created before isolation get the admin/first user so
// they don't vanish from the owner's view. EXCEPTION (2026-09-19): keep
// sniper_recent_tokens + sniper_trades NULL-legacy rows SHARED — the token
// memory and trade ledger are seeded history; stamping them to admin makes
// them invisible to every other user (the "lost token input memory" bug).
try {
  const _defUser = _defaultUserId();
  if (_defUser) {
    for (const t of ["dip_watchers", "dip_trades", "accumulation_strategies", "strategy_executions", "copilot_requests", "zooch_reviews"]) {
      db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id IS NULL`).run(_defUser);
    }
  }
} catch (e) {
  console.error(`[db] isolation backfill skipped: ${e.message}`);
}
// Sniper token memory: every token entered (checked liquidity) is remembered
// per chain, and one token per chain is "active" — the bot's current target.
// The active token auto-resumes on page load / chain switch until a different
// token is entered.
db.exec(`
  CREATE TABLE IF NOT EXISTS sniper_recent_tokens (
      chain            TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      symbol           TEXT,
      last_used_at     TEXT NOT NULL DEFAULT (datetime('now')),
      use_count        INTEGER NOT NULL DEFAULT 1,
      is_active        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chain, contract_address)
    );
`);
// Honeypot-verification state (sell-probe): a token is "verified" once a
// miniscule buy+sell round-trip actually delivered proceeds to the wallet.
ensureColumn("sniper_recent_tokens", "verified_at", "verified_at TEXT");
ensureColumn("sniper_recent_tokens", "verified_via", "verified_via TEXT");

/** Mark a token honeypot-verified (probe or a real delivered sell). */
export function setSniperTokenVerified(chain, contract_address, via = "probe") {
  db.prepare(`UPDATE sniper_recent_tokens SET verified_at = datetime('now'), verified_via = ? WHERE chain = ? AND contract_address = ?`)
    .run(via, chain, String(contract_address).toLowerCase());
}

/** Honeypot-verification state for a token, or null when never probed. */
export function getSniperTokenVerification(chain, contract_address) {
  return db.prepare(`SELECT verified_at, verified_via FROM sniper_recent_tokens WHERE chain = ? AND contract_address = ?`)
    .get(chain, String(contract_address).toLowerCase()) ?? null;
}

/** Record a token as entered and (by default) make it the chain's active one. */
export function touchSniperToken({ chain, contract_address, symbol = null, activate = true }) {
  const addr = String(contract_address).toLowerCase();
  db.prepare(`
    INSERT INTO sniper_recent_tokens (chain, contract_address, symbol, last_used_at, use_count, is_active)
    VALUES (?, ?, ?, datetime('now'), 1, ?)
    ON CONFLICT(chain, contract_address) DO UPDATE SET
      symbol = COALESCE(excluded.symbol, sniper_recent_tokens.symbol),
      last_used_at = datetime('now'),
      use_count = use_count + 1,
      is_active = excluded.is_active
  `).run(chain, addr, symbol ?? null, activate ? 1 : 0);
}

/** Recent tokens for a chain, active first, then most-recently used. */
export function getSniperRecentTokens(chain, limit = 12, userId = null) {
  // Per-user (2026-09-19): remembered tokens + verification state are
  // per-user. NULL-legacy rows remain visible to everyone (admin history).
  return db.prepare(`
    SELECT contract_address, symbol, last_used_at, use_count, is_active,
           verified_at, verified_via
    FROM sniper_recent_tokens
    WHERE chain = ? ${userId ? "AND (user_id = ? OR user_id IS NULL)" : ""}
    ORDER BY is_active DESC, last_used_at DESC
    LIMIT ?
  `).all(...(userId ? [chain, userId, limit] : [chain, limit]));
}

/** The chain's active token (the bot's current target), or null. */
export function getSniperActiveToken(chain) {
  return db.prepare(`
    SELECT contract_address, symbol FROM sniper_recent_tokens
    WHERE chain = ? AND is_active = 1
    LIMIT 1
  `).get(chain) ?? null;
}

// Auto-sell orders: armed server-side (dashboard process), independent of the
// buy flow — arm against existing holdings. target_pct is relative to the
// position's net cost basis in ETH (e.g. 50 = sell when value ≥ 1.5× cost).
db.exec(`
  CREATE TABLE IF NOT EXISTS sniper_autosells (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    chain            TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    symbol           TEXT,
    target_pct       REAL NOT NULL,
    cost_at_arm_eth  REAL NOT NULL,
    status           TEXT NOT NULL DEFAULT 'armed',  -- armed|triggering|triggered|error|cancelled
    sell_tx_hash     TEXT,
    error            TEXT,
    user_id          TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    triggered_at     TEXT
  );
`);

/** Arm auto-sell for a token (replaces any armed order for the same token). */
export function armSniperAutoSell({ chain, contract_address, symbol, target_pct, cost_at_arm_eth, user_id = null }) {
  db.prepare("UPDATE sniper_autosells SET status = 'cancelled' WHERE chain = ? AND contract_address = ? AND status = 'armed'").run(chain, String(contract_address).toLowerCase());
  const r = db.prepare(`
    INSERT INTO sniper_autosells (chain, contract_address, symbol, target_pct, cost_at_arm_eth, user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(chain, String(contract_address).toLowerCase(), symbol ?? null, target_pct, cost_at_arm_eth, user_id ?? null);
  return r.lastInsertRowid;
}

export function cancelSniperAutoSells(chain, contractAddress) {
  // Also cancels rows stuck in 'triggering' (a crashed tick can leave one there
  // — those used to be uncancellable forever since only 'armed' matched).
  return db.prepare("UPDATE sniper_autosells SET status = 'cancelled' WHERE chain = ? AND contract_address = ? AND status IN ('armed', 'triggering')").run(chain, String(contractAddress).toLowerCase()).changes;
}

/** Atomically claim an armed order for execution (prevents double-sell across ticks). */
export function claimSniperAutoSell(id) {
  return db.prepare("UPDATE sniper_autosells SET status = 'triggering', triggered_at = datetime('now') WHERE id = ? AND status = 'armed'").run(id).changes > 0;
}

export function settleSniperAutoSell(id, { txHash = null, error = null, revertToArmed = false }) {
  if (error && revertToArmed) {
    db.prepare("UPDATE sniper_autosells SET status = 'armed', triggered_at = NULL, error = ? WHERE id = ?").run(String(error), id);
    return;
  }
  if (error) {
    db.prepare("UPDATE sniper_autosells SET status = 'error', error = ? WHERE id = ?").run(String(error), id);
    return;
  }
  db.prepare("UPDATE sniper_autosells SET status = 'triggered', sell_tx_hash = ? WHERE id = ?").run(txHash, id);
}

/** Armed orders for the loop (all chains) or one chain. */
export function getArmedSniperAutoSells(chain = null) {
  return chain
    ? db.prepare("SELECT * FROM sniper_autosells WHERE chain = ? AND status = 'armed' ORDER BY id").all(chain)
    : db.prepare("SELECT * FROM sniper_autosells WHERE status = 'armed' ORDER BY id").all();
}

/** Recent auto-sell orders for the UI. Per-user (2026-09-19). */
export function getSniperAutoSells(chain, limit = 10, userId = null) {
  return db.prepare(
    `SELECT * FROM sniper_autosells WHERE chain = ? ${userId ? "AND (user_id = ? OR user_id IS NULL)" : ""} ORDER BY id DESC LIMIT ?`
  ).all(...(userId ? [chain, userId, limit] : [chain, limit]));
}

// ── Watchers ──────────────────────────────────────────────────────────────────

export function getDipWatchers(userId = null) {
  if (userId) return db.prepare("SELECT * FROM dip_watchers WHERE user_id = ? ORDER BY created_at DESC").all(userId);
  return db.prepare("SELECT * FROM dip_watchers ORDER BY created_at DESC").all();
}

export function getActiveDipWatchers(userId = null) {
  if (userId) return db.prepare("SELECT * FROM dip_watchers WHERE active = 1 AND user_id = ?").all(userId);
  return db.prepare("SELECT * FROM dip_watchers WHERE active = 1").all();
}

export function getDipWatcher(id) {
  return db.prepare("SELECT * FROM dip_watchers WHERE id = ?").get(id);
}

export function addDipWatcher({ id, chain = "ethereum", contractAddress, symbol, decimals = 18, thresholdUsd, buyAmountUsd, slippagePct = 3, cooldownMinutes = 15, poolAddress = null, userId = null }) {
  db.prepare(`
    INSERT INTO dip_watchers (id, chain, contract_address, symbol, decimals, threshold_usd, buy_amount_usd, slippage_pct, cooldown_minutes, pool_address, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, chain, contractAddress.toLowerCase(), symbol ?? null, decimals ?? 18, thresholdUsd, buyAmountUsd, slippagePct ?? 3, cooldownMinutes ?? 15, poolAddress, userId);
}

export function setDipWatcherActive(id, active) {
  db.prepare("UPDATE dip_watchers SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

export function updateDipWatcherSettings(id, { thresholdUsd, buyAmountUsd, slippagePct, cooldownMinutes }) {
  db.prepare(`
    UPDATE dip_watchers SET
      threshold_usd = ?, buy_amount_usd = ?, slippage_pct = ?, cooldown_minutes = ?
    WHERE id = ?
  `).run(thresholdUsd, buyAmountUsd, slippagePct, cooldownMinutes, id);
}

/** Narrow update: just the watcher's slippage (dip buys read watcher.slippage_pct). */
export function updateDipWatcherSlippage(id, slippagePct) {
  db.prepare("UPDATE dip_watchers SET slippage_pct = ? WHERE id = ?").run(slippagePct, id);
}

export function removeDipWatcher(id) {
  db.prepare("DELETE FROM dip_watchers WHERE id = ?").run(id);
}

export function touchDipWatcherTriggered(id) {
  db.prepare("UPDATE dip_watchers SET last_triggered_at = datetime('now') WHERE id = ?").run(id);
}

/** Persist the resolved pool (V3 pool address or V4 poolId hex) for a watcher. */
export function setDipWatcherPool(id, poolAddress) {
  db.prepare("UPDATE dip_watchers SET pool_address = ? WHERE id = ?").run(poolAddress ?? null, id);
}

/** Store a freshly computed wallet-position snapshot (see wallet-position.mjs). */
export function updateWalletPosition(id, { balance, balanceUsd, priceUsd, costBasisUsd, unrealizedPlUsd, unrealizedPlPct, realizedPlUsd, error } = {}) {
  db.prepare(`
    UPDATE dip_watchers SET
      wallet_balance = ?, wallet_balance_usd = ?, price_usd = ?, cost_basis_usd = ?,
      unrealized_pl_usd = ?, unrealized_pl_pct = ?, realized_pl_usd = ?, position_updated_at = datetime('now'), position_error = ?
    WHERE id = ?
  `).run(balance ?? null, balanceUsd ?? null, priceUsd ?? null, costBasisUsd ?? null, unrealizedPlUsd ?? null, unrealizedPlPct ?? null, realizedPlUsd ?? null, error ?? null, id);
}

export function isDipWatcherCoolingDown(id) {
  const w = getDipWatcher(id);
  if (!w?.last_triggered_at) return false;
  const elapsedMin = (Date.now() - new Date(w.last_triggered_at + "Z").getTime()) / 60000;
  return elapsedMin < (w.cooldown_minutes ?? 15);
}

// ── Trades ────────────────────────────────────────────────────────────────────

export function insertDipTrade({ watcher_id, sell_tx_hash, sell_usd, buy_tx_hash, eth_spent, token_amount, price_usd, strategy_id = null, execution_kind = null, status = "ok", error = null, user_id = null }) {
  // user_id: passed from the watcher (copied from the watcher row) or derived
  // from the watcher when a dashboard caller omits it.
  const uid = user_id ?? db.prepare("SELECT user_id FROM dip_watchers WHERE id = ?").get(watcher_id)?.user_id ?? null;
  db.prepare(`
    INSERT INTO dip_trades (watcher_id, sell_tx_hash, sell_usd, buy_tx_hash, eth_spent, token_amount, price_usd, strategy_id, execution_kind, status, error, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(watcher_id, sell_tx_hash ?? null, sell_usd ?? null, buy_tx_hash ?? null, eth_spent ?? null, token_amount ?? null, price_usd ?? null, strategy_id, execution_kind, status, error, uid);
}

export function getDipTrades(watcherId = null, limit = 50, userId = null) {
  if (watcherId) {
    return db.prepare(`
      SELECT t.*, w.chain FROM dip_trades t
      JOIN dip_watchers w ON w.id = t.watcher_id
      WHERE t.watcher_id = ? ORDER BY t.created_at DESC LIMIT ?
    `).all(watcherId, limit);
  }
  return db.prepare(`
    SELECT t.*, w.symbol, w.contract_address, w.chain FROM dip_trades t
    JOIN dip_watchers w ON w.id = t.watcher_id
    ${userId ? "WHERE t.user_id = ?" : ""}
    ORDER BY t.created_at DESC LIMIT ?
  `).all(...(userId ? [userId] : []), limit);
}

// ── Zooch reviews ────────────────────────────────────────────────────────────

export function createZoochReview({ id, watcherId, contractAddress, symbol, request, chain = "ethereum" }) {
  db.prepare(`
    INSERT INTO zooch_reviews (id, watcher_id, contract_address, symbol, request_json, chain)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, watcherId, contractAddress.toLowerCase(), symbol ?? null, JSON.stringify(request), chain);
}

export function getZoochReview(id) {
  const row = db.prepare("SELECT * FROM zooch_reviews WHERE id = ?").get(id);
  return row ? hydrateReview(row) : null;
}

export function getZoochReviews(watcherId, limit = 20) {
  return db.prepare(`
    SELECT * FROM zooch_reviews WHERE watcher_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(watcherId, limit).map(hydrateReview);
}

export function setZoochReviewRunning(id) {
  db.prepare("UPDATE zooch_reviews SET status = 'running', error = NULL WHERE id = ?").run(id);
}

export function completeZoochReview(id, { evidence, proposal, narrative }) {
  db.prepare(`
    UPDATE zooch_reviews SET
      evidence_json = ?, proposal_json = ?, narrative_json = ?, status = 'complete',
      error = NULL, completed_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(evidence), JSON.stringify(proposal), narrative == null ? null : JSON.stringify(narrative), id);
}

export function failZoochReview(id, error) {
  db.prepare(`
    UPDATE zooch_reviews SET status = 'failed', error = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(error, id);
}

function hydrateReview(row) {
  return {
    ...row,
    request: parseJson(row.request_json),
    evidence: parseJson(row.evidence_json),
    proposal: parseJson(row.proposal_json),
    narrative: parseJson(row.narrative_json),
  };
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

// ── Approved accumulation strategies ─────────────────────────────────────────

export function getAccumulationStrategy(watcherId) {
  return db.prepare("SELECT * FROM accumulation_strategies WHERE watcher_id = ?").get(watcherId);
}

export function getActiveAccumulationStrategies() {
  return db.prepare(`
    SELECT s.*, w.contract_address, w.symbol, w.decimals, w.chain
    FROM accumulation_strategies s
    JOIN dip_watchers w ON w.id = s.watcher_id
    WHERE s.active = 1 AND w.active = 1 AND s.end_at > datetime('now')
    ORDER BY s.next_scheduled_at ASC
  `).all();
}

export function applyAccumulationStrategy({ id, reviewId = "manual", watcherId, proposal, replace = false }) {
  const now = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const nextScheduledAt = proposal.startAt > now ? proposal.startAt : now;
  const run = db.transaction(() => {
    const existing = db.prepare("SELECT * FROM accumulation_strategies WHERE watcher_id = ?").get(watcherId);
    if (existing?.active && !replace) throw new Error("an active Zooch strategy already exists for this token; confirm replacement to continue");
    // Editing an existing plan must not wipe out budget already spent under it —
    // reuse the same id (strategy_executions FK stays valid) and carry forward
    // deployed/reserved totals instead of resetting them to 0.
    const strategyId = existing ? existing.id : id;
    const deployedBudgetUsd = existing?.deployed_budget_usd ?? 0;
    const reservedBudgetUsd = existing?.reserved_budget_usd ?? 0;
    db.prepare("DELETE FROM accumulation_strategies WHERE watcher_id = ?").run(watcherId);
    db.prepare(`
      INSERT INTO accumulation_strategies (
        id, watcher_id, review_id, profile, total_budget_usd, max_buy_usd, base_buy_usd, dip_buy_usd,
        dip_threshold_usd, slippage_pct, cooldown_minutes, cadence_minutes, scheduled_allocation_usd,
        dip_reserve_usd, start_at, end_at, next_scheduled_at, deployed_budget_usd, reserved_budget_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      strategyId, watcherId, reviewId, proposal.profile, proposal.totalBudgetUsd, proposal.maxBuyUsd,
      proposal.baseBuyUsd, proposal.dipBuyUsd, proposal.dipThresholdUsd, proposal.slippagePct,
      proposal.cooldownMinutes, proposal.cadenceMinutes, proposal.scheduledAllocationUsd,
      proposal.dipReserveUsd, proposal.startAt, proposal.endAt, nextScheduledAt, deployedBudgetUsd, reservedBudgetUsd
    );
    db.prepare(`
      UPDATE dip_watchers SET threshold_usd = ?, buy_amount_usd = ?, slippage_pct = ?, cooldown_minutes = ?
      WHERE id = ?
    `).run(proposal.dipThresholdUsd, proposal.dipBuyUsd, proposal.slippagePct, proposal.cooldownMinutes, watcherId);
  });
  run();
  return getAccumulationStrategy(watcherId);
}

export function setAccumulationStrategyActive(watcherId, active) {
  db.prepare("UPDATE accumulation_strategies SET active = ?, updated_at = datetime('now') WHERE watcher_id = ?").run(active ? 1 : 0, watcherId);
}

/** Reserve strategy budget before submitting a transaction to prevent duplicate
 * buys in overlapping event/schedule handlers or after a daemon restart. */
export function reserveStrategyExecution({ strategyId, watcherId, kind, amountUsd, scheduledFor = null, ignoreSchedule = false }) {
  if (!(amountUsd > 0)) throw new Error("strategy execution amount must be positive");
  const run = db.transaction(() => {
    const strategy = db.prepare("SELECT * FROM accumulation_strategies WHERE id = ?").get(strategyId);
    if (!strategy || !strategy.active || strategy.end_at <= new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")) {
      throw new Error("strategy is no longer active");
    }
    if (strategy.deployed_budget_usd + strategy.reserved_budget_usd + amountUsd > strategy.total_budget_usd + 0.000001) {
      throw new Error("strategy budget exhausted");
    }
    const allocation = kind === "scheduled" ? strategy.scheduled_allocation_usd : strategy.dip_reserve_usd;
    // Scope the allocation sum to the CURRENT plan (executions since start_at).
    // applyAccumulationStrategy reuses the strategy id across edits and carries
    // deployed/reserved forward, but prior-plan history must not count against
    // the new plan's allocation — otherwise a smaller re-plan can deadlock
    // (e.g. LAPTOP: $19 of old-plan scheduled buys vs a $15 new allocation).
    const allocated = db.prepare(`
      SELECT COALESCE(SUM(amount_usd), 0) AS amount
      FROM strategy_executions
      WHERE strategy_id = ? AND kind = ? AND status IN ('reserved', 'ok')
        AND created_at >= ?
    `).get(strategyId, kind, strategy.start_at).amount;
    if (allocated + amountUsd > allocation + 0.000001) {
      throw new Error(`${kind} allocation exhausted`);
    }
    if (kind === "scheduled" && !ignoreSchedule && strategy.next_scheduled_at > new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")) {
      throw new Error("scheduled buy is not due");
    }
    if (kind === "dip" && strategy.last_dip_at) {
      const elapsedMinutes = (Date.now() - new Date(`${strategy.last_dip_at}Z`).getTime()) / 60_000;
      if (elapsedMinutes < strategy.cooldown_minutes) throw new Error("dip cooldown is active");
    }
    const execution = db.prepare(`
      INSERT INTO strategy_executions (strategy_id, watcher_id, kind, amount_usd, scheduled_for, tx_hash, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(strategyId, watcherId, kind, amountUsd, scheduledFor, null, "reserved", null);
    const updates = kind === "scheduled"
      ? "reserved_budget_usd = reserved_budget_usd + ?, last_scheduled_at = datetime('now'), next_scheduled_at = datetime(next_scheduled_at, '+' || cadence_minutes || ' minutes'), updated_at = datetime('now')"
      : "reserved_budget_usd = reserved_budget_usd + ?, last_dip_at = datetime('now'), updated_at = datetime('now')";
    db.prepare(`UPDATE accumulation_strategies SET ${updates} WHERE id = ?`).run(amountUsd, strategyId);
    return { strategy, executionId: execution.lastInsertRowid };
  });
  return run();
}

/** Finalize a reservation. Failed transactions release the budget; scheduled
 * failures keep their advanced cadence to avoid rapid retry loops. */
export function finalizeStrategyExecution({ executionId, txHash = null, error = null }) {
  const run = db.transaction(() => {
    const execution = db.prepare("SELECT * FROM strategy_executions WHERE id = ?").get(executionId);
    if (!execution || execution.status !== "reserved") throw new Error("strategy reservation not found");
    db.prepare(`
      UPDATE strategy_executions SET status = ?, tx_hash = ?, error = ? WHERE id = ?
    `).run(error ? "error" : "ok", txHash, error, executionId);
    const budgetChange = error ? 0 : execution.amount_usd;
    db.prepare(`
      UPDATE accumulation_strategies
      SET reserved_budget_usd = MAX(0, reserved_budget_usd - ?),
          deployed_budget_usd = deployed_budget_usd + ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(execution.amount_usd, budgetChange, execution.strategy_id);
    return execution;
  });
  return run();
}

export function insertSniperTrade({ chain, contract_address, symbol, dex, eth_spent, token_amount, buy_tx_hash, status = "ok", error = null, eth_received = null, user_id = null }) {
  // Owner stamping (2026-09-19): every trade carries its user so ledgers,
  // P/L, and the trades list can be per-user. NULL = legacy/unstamped
  // (treated as admin-owned, same convention as the other tables).
  db.prepare(`
    INSERT INTO sniper_trades (chain, contract_address, symbol, dex, eth_spent, token_amount, buy_tx_hash, status, error, eth_received, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(chain, contract_address, symbol ?? null, dex ?? null, eth_spent ?? null, token_amount ?? null, buy_tx_hash ?? null, status, error, eth_received ?? null, user_id ?? null);
}

export function getSniperTrades(limit = 50, userId = null) {
  // Per-user (2026-09-19): overview passes the session user; null = all
  // (legacy/internal callers that legitimately need the full ledger).
  if (userId) return db.prepare("SELECT * FROM sniper_trades WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit);
  return db.prepare("SELECT * FROM sniper_trades ORDER BY created_at DESC LIMIT ?").all(limit);
}

/**
 * Tokens whose trade ledger shows a sell that explicitly recorded near-zero
 * proceeds — OPAI-style (sell quoted/delivered dust vs what was paid in).
 * CRITICAL: sells with eth_received NULL are UNKNOWN, not zero (the Long
 * platform path and some wallet-sync rows don't record proceeds) — treating
 * null as 0 falsely flagged sellable tokens like ATLANTIS. Only a sell that
 * recorded a real (non-null) number can count as evidence, and only when the
 * token's total delivered is materially below what was paid in (same 50%
 * line as sell-probe.mjs). QUORUM-style traps (quoted proceeds recorded,
 * $0 actually delivered) are NOT catchable here — they live in the explicit
 * honeypot_tokens registry instead.
 */
export function getSniperHoneypotTokens(limit = 50) {
  return db.prepare(`
    SELECT chain, contract_address, MAX(symbol) AS symbol,
           SUM(CASE WHEN dex NOT LIKE 'SELL%' AND dex NOT LIKE 'PROBE%' AND dex NOT LIKE '%(verify)%'
                    THEN COALESCE(eth_spent, 0) ELSE 0 END) AS eth_in,
           SUM(CASE WHEN (dex LIKE 'SELL%' OR dex LIKE 'PROBE%') AND eth_received IS NOT NULL
                    THEN eth_received ELSE 0 END) AS eth_out,
           SUM(CASE WHEN (dex LIKE 'SELL%' OR dex LIKE 'PROBE%') AND eth_received IS NOT NULL THEN 1 ELSE 0 END) AS sells_with_proceeds,
           SUM(CASE WHEN dex LIKE 'SELL%' THEN 1 ELSE 0 END) AS sell_txs,
           COUNT(*) AS txs
    FROM sniper_trades
    WHERE status = 'ok'
    GROUP BY chain, contract_address
    HAVING sell_txs > 0 AND sells_with_proceeds > 0 AND eth_in > 0 AND eth_out < 0.5 * eth_in
    ORDER BY (eth_in - eth_out) DESC
    LIMIT ?
  `).all(limit);
}

// Explicit honeypot registry — tokens flagged as traps that ledger inference
// cannot prove (QUORUM-style: quoted proceeds recorded, $0 actually delivered;
// or buy-side taxes invisible to the sell-deliverability probe). The user
// curates this via the Overview card; eth_lost is optional (ETH units) and
// overrides the ledger-implied loss when set.
db.exec(`
  CREATE TABLE IF NOT EXISTS honeypot_tokens (
    chain            TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    symbol           TEXT,
    eth_lost         REAL,        -- user-stated loss in ETH; NULL = derive from the trade ledger
    note             TEXT,
    source           TEXT NOT NULL DEFAULT 'manual',  -- manual | ledger | exit-guard
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chain, contract_address)
  );
`);

/** Flag a token as a honeypot (upsert). */
export function addHoneypotToken({ chain, contractAddress, symbol = null, ethLost = null, note = null, source = "manual" }) {
  db.prepare(`
    INSERT INTO honeypot_tokens (chain, contract_address, symbol, eth_lost, note, source)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chain, contract_address) DO UPDATE SET
      symbol = COALESCE(excluded.symbol, honeypot_tokens.symbol),
      eth_lost = excluded.eth_lost,
      note = COALESCE(excluded.note, honeypot_tokens.note),
      source = excluded.source
  `).run(chain, String(contractAddress).toLowerCase(), symbol, ethLost, note, source);
}

export function removeHoneypotToken(chain, contractAddress) {
  return db.prepare("DELETE FROM honeypot_tokens WHERE chain = ? AND contract_address = ?")
    .run(chain, String(contractAddress).toLowerCase()).changes;
}

export function listHoneypotTokens() {
  return db.prepare("SELECT * FROM honeypot_tokens ORDER BY created_at DESC").all();
}

/**
 * Accumulate exits that the honeypot guard flagged (swap "succeeded", $0
 * quote asset delivered — the QUORUM signature). Returns one row per watcher
 * with the sold token amount and its price at exit time, so the loss can be
 * valued in USD.
 */
export function getDipHoneypotExits() {
  return db.prepare(`
    SELECT e.watcher_id, MAX(w.symbol) AS symbol, MAX(w.chain) AS chain,
           MAX((
             SELECT t.token_amount FROM dip_trades t
              WHERE t.watcher_id = e.watcher_id AND t.execution_kind = 'exit'
                AND t.token_amount < 0 AND t.status = 'ok' AND t.created_at <= e.created_at
              ORDER BY t.created_at DESC, t.id DESC LIMIT 1
           )) AS sold_tokens,
           MAX((
             SELECT t.price_usd FROM dip_trades t
              WHERE t.watcher_id = e.watcher_id AND t.execution_kind = 'exit'
                AND t.token_amount < 0 AND t.status = 'ok' AND t.created_at <= e.created_at
              ORDER BY t.created_at DESC, t.id DESC LIMIT 1
           )) AS price_usd
    FROM dip_trades e
    JOIN dip_watchers w ON w.id = e.watcher_id
    WHERE e.status = 'error' AND e.error LIKE '%HONEYPOT SUSPECTED%'
    GROUP BY e.watcher_id
  `).all();
}

/**
 * Full ok-trade history for one token on one chain, oldest first.
 * Buys carry eth_spent; sells carry eth_spent = 0 + eth_received.
 */
export function getSniperTokenHistory(chain, contractAddress, userId = null) {
  // Per-user (2026-09-19): the ledger drives P/L + autosell math, so it MUST
  // be owner-scoped. userId = the session user's own rows + NULL-legacy rows
  // (pre-stamping history belongs to admin by convention). null userId =
  // internal/full-ledger callers (wallet-sync dedupe) — unchanged.
  return db.prepare(`
    SELECT * FROM sniper_trades
    WHERE chain = ? AND contract_address = ? AND status = 'ok'
      AND (eth_spent IS NOT NULL OR eth_received IS NOT NULL)
      ${userId ? "AND (user_id = ? OR user_id IS NULL)" : ""}
    ORDER BY created_at ASC, id ASC
  `).all(...(userId ? [chain, String(contractAddress).toLowerCase(), userId] : [chain, String(contractAddress).toLowerCase()]));
}

/** ALL rows for a token INCLUDING unpriced ones (eth_spent AND eth_received
 *  both NULL). wallet-sync's dedupe must see these too — a tx recorded
 *  unpriced by an older sync must not be re-inserted as a priced duplicate
 *  on the next pull (HASH 0xeedd4c58 was double-counted this way). */
export function getSniperTokenHistoryUnpriced(chain, contractAddress, userId = null) {
  return db.prepare(`
    SELECT * FROM sniper_trades
    WHERE chain = ? AND contract_address = ? AND status = 'ok'
      AND eth_spent IS NULL AND eth_received IS NULL
      ${userId ? "AND (user_id = ? OR user_id IS NULL)" : ""}
    ORDER BY created_at ASC, id ASC
  `).all(...(userId ? [chain, String(contractAddress).toLowerCase(), userId] : [chain, String(contractAddress).toLowerCase()]));
}