/**
 * mm-db.mjs — SQLite for the Market Maker tab.
 * Own connection to the same data/accumulate.db (WAL supports multiple
 * connections). Tables + CRUD live here so db.mjs stays untouched.
 *
 * mm_strategies — one row per token being market-made.
 * mm_trades     — every executed (or dry-run-recorded) MM leg.
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
  CREATE TABLE IF NOT EXISTS mm_strategies (
    id                    TEXT PRIMARY KEY,
    chain                 TEXT NOT NULL DEFAULT 'robinhood',
    token_address         TEXT NOT NULL,
    symbol                TEXT,
    decimals              INTEGER NOT NULL DEFAULT 18,
    mode                  TEXT NOT NULL DEFAULT 'spread',
    bid_offset_pct        REAL NOT NULL DEFAULT 1.0,
    ask_offset_pct        REAL NOT NULL DEFAULT 1.0,
    skew_weight_pct       REAL NOT NULL DEFAULT 0.5,
    trade_size_usd        REAL NOT NULL DEFAULT 25,
    max_trade_usd         REAL NOT NULL DEFAULT 100,
    max_inventory_usd     REAL NOT NULL DEFAULT 500,
    cooldown_minutes      REAL NOT NULL DEFAULT 10,
    max_trades_per_day    INTEGER NOT NULL DEFAULT 12,
    max_impact_pct        REAL NOT NULL DEFAULT 2.0,
    min_liquidity_usd     REAL NOT NULL DEFAULT 5000,
    min_external_txns     INTEGER NOT NULL DEFAULT 2,
    daily_loss_limit_usd  REAL NOT NULL DEFAULT 50,
    slippage_pct          REAL NOT NULL DEFAULT 3,
    venue_override        TEXT,
    active                INTEGER NOT NULL DEFAULT 0,
    -- runtime state (updated by the daemon)
    last_side             TEXT,
    last_trade_at         TEXT,
    last_price_usd        REAL,
    inventory_tokens      REAL NOT NULL DEFAULT 0,
    cost_basis_usd        REAL NOT NULL DEFAULT 0,
    realized_pl_usd       REAL NOT NULL DEFAULT 0,
    error_streak          INTEGER NOT NULL DEFAULT 0,
    last_error            TEXT,
    dry_run               INTEGER NOT NULL DEFAULT 1,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mm_trades (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id    TEXT NOT NULL,
    side           TEXT NOT NULL,           -- 'buy' | 'sell'
    dry_run        INTEGER NOT NULL DEFAULT 0,
    reason         TEXT,
    usd_size       REAL,
    token_amount   REAL,
    price_usd      REAL,
    impact_pct     REAL,
    eth_amount     REAL,
    tx_hash        TEXT,
    status         TEXT NOT NULL DEFAULT 'ok',
    error          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
// Migration pattern per CLAUDE.md — add future columns here.
// ensureColumn("mm_strategies", "future_col", "future_col TEXT");
// Fair-value anchor: time-based EMA state (mm-watcher). The old scheme folded
// fair value into last_price_usd with a 0.7/0.3 blend per 60s poll — a ~2min
// half-life that chased every drift, so the bid/ask band slid down with the
// market and price sat "inside band" forever (848 blocked ticks on SIRIUS,
// 2026-09-11). Fair value now lives in its own columns with a wall-clock
// time constant, so real dips exit the band before the anchor absorbs them.
ensureColumn("mm_strategies", "fair_value_usd", "fair_value_usd REAL");
ensureColumn("mm_strategies", "fair_value_at", "fair_value_at TEXT");
// Sell-after-sell exception (2026-09-11): the alternation gate made rallies
// unsellable — last leg sell ⇒ only a buy can fire next, so a +28% pump
// (SIRIUS) could never be sold. Price of the previous sell is stored so the
// engine can allow sell-after-sell when price runs ≥30% past it.
ensureColumn("mm_strategies", "last_sell_price_usd", "last_sell_price_usd REAL");

const newId = () => crypto.randomUUID();

export function listMmStrategies() {
  return db.prepare("SELECT * FROM mm_strategies ORDER BY created_at DESC").all();
}

export function getMmStrategy(id) {
  return db.prepare("SELECT * FROM mm_strategies WHERE id = ?").get(id);
}

export function createMmStrategy(input) {
  const id = newId();
  db.prepare(`
    INSERT INTO mm_strategies (id, chain, token_address, symbol, decimals, mode,
      bid_offset_pct, ask_offset_pct, trade_size_usd, max_trade_usd, max_inventory_usd,
      cooldown_minutes, max_trades_per_day, max_impact_pct, min_liquidity_usd,
      min_external_txns, daily_loss_limit_usd, slippage_pct, venue_override, active, dry_run)
    VALUES (@id, @chain, @token_address, @symbol, @decimals, @mode,
      @bid_offset_pct, @ask_offset_pct, @trade_size_usd, @max_trade_usd, @max_inventory_usd,
      @cooldown_minutes, @max_trades_per_day, @max_impact_pct, @min_liquidity_usd,
      @min_external_txns, @daily_loss_limit_usd, @slippage_pct, @venue_override, 0, 1)
  `).run({
    chain: "robinhood", symbol: null, decimals: 18, mode: "spread",
    bid_offset_pct: 1.0, ask_offset_pct: 1.0, trade_size_usd: 25, max_trade_usd: 100,
    max_inventory_usd: 500, cooldown_minutes: 10, max_trades_per_day: 20,
    max_impact_pct: 2.0, min_liquidity_usd: 5000, min_external_txns: 2,
    daily_loss_limit_usd: 50, slippage_pct: 3, venue_override: null,
    ...input,
    id,
  });
  return getMmStrategy(id);
}

const MM_FIELDS = new Set([
  "symbol", "decimals", "bid_offset_pct", "ask_offset_pct", "trade_size_usd",
  "max_trade_usd", "max_inventory_usd", "cooldown_minutes", "max_trades_per_day",
  "max_impact_pct", "min_liquidity_usd", "min_external_txns", "daily_loss_limit_usd",
  "slippage_pct", "venue_override", "active", "last_side", "last_trade_at",
  "last_price_usd", "inventory_tokens", "cost_basis_usd", "realized_pl_usd",
  "error_streak", "last_error", "dry_run",
  "fair_value_usd", "fair_value_at", "last_sell_price_usd",
]);

export function updateMmStrategy(id, patch) {
  const cols = Object.keys(patch).filter((k) => MM_FIELDS.has(k));
  if (!cols.length) return;
  const setSql = cols.map((c) => `${c} = @${c}`).join(", ");
  db.prepare(`UPDATE mm_strategies SET ${setSql}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...patch, id });
}

export function deleteMmStrategy(id) {
  db.prepare("DELETE FROM mm_strategies WHERE id = ?").run(id);
  db.prepare("DELETE FROM mm_trades WHERE strategy_id = ?").run(id);
}

export function insertMmTrade(t) {
  db.prepare(`
    INSERT INTO mm_trades (strategy_id, side, dry_run, reason, usd_size, token_amount,
      price_usd, impact_pct, eth_amount, tx_hash, status, error)
    VALUES (@strategy_id, @side, @dry_run, @reason, @usd_size, @token_amount,
      @price_usd, @impact_pct, @eth_amount, @tx_hash, @status, @error)
  `).run({ dry_run: 0, reason: null, usd_size: null, token_amount: null, price_usd: null,
    impact_pct: null, eth_amount: null, tx_hash: null, status: "ok", error: null, ...t });
}

// ── position math ────────────────────────────────────────────────────────────

/**
 * Recompute a strategy's bot-position numbers from its trade history — the
 * ledger is the source of truth, so this self-heals any stale rows.
 * Convention: cost is only charged against tokens the bot itself bought
 * (pre-existing wallet inventory sells for $0 cost — desk convention);
 * proceeds are booked at the trade's intended USD size.
 */
export function computeMmPosition(strategyId) {
  const trades = db.prepare(`
    SELECT side, usd_size, token_amount FROM mm_trades
    WHERE strategy_id = ? AND status = 'ok' AND dry_run = 0
    ORDER BY created_at ASC, id ASC
  `).all(strategyId);
  let botTokens = 0, basis = 0, realized = 0;
  for (const t of trades) {
    const amt = Number(t.token_amount || 0), usd = Number(t.usd_size || 0);
    if (t.side === "buy") {
      botTokens += amt; basis += usd;
    } else {
      const soldFromBot = Math.min(amt, botTokens);
      const cost = botTokens > 0 ? (basis / botTokens) * soldFromBot : 0;
      realized += usd - cost;
      botTokens -= soldFromBot;
      basis = Math.max(0, basis - cost);
    }
  }
  return { botTokens, costBasisUsd: basis, realizedPlUsd: realized };
}

export function getMmTrades(limit = 40, strategyId = null) {
  // LEFT JOIN mm_strategies for the token symbol (the history table shows all
  // strategies' trades together — without the join the rows are anonymous).
  if (strategyId) {
    return db.prepare(`
      SELECT t.*, s.symbol
      FROM mm_trades t LEFT JOIN mm_strategies s ON s.id = t.strategy_id
      WHERE t.strategy_id = ? ORDER BY t.id DESC LIMIT ?
    `).all(strategyId, limit);
  }
  return db.prepare(`
    SELECT t.*, s.symbol
    FROM mm_trades t LEFT JOIN mm_strategies s ON s.id = t.strategy_id
    ORDER BY t.id DESC LIMIT ?
  `).all(limit);
}

/** Today's (UTC) executed flows — feeds the daily loss limit and trade cap. */
export function getMmTodayFlows(strategyId) {
  return db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN side='sell' THEN price_usd * token_amount ELSE 0 END), 0) AS sell_usd,
      COALESCE(SUM(CASE WHEN side='buy'  THEN price_usd * token_amount ELSE 0 END), 0) AS buy_usd,
      COUNT(*) AS count
    FROM mm_trades
    WHERE strategy_id = ? AND status = 'ok' AND dry_run = 0 AND created_at >= date('now')
  `).get(strategyId);
}

/** Trades executed today (any status) — feeds max_trades_per_day. */
export function countMmTradesToday(strategyId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM mm_trades
    WHERE strategy_id = ? AND dry_run = 0 AND created_at >= date('now')
  `).get(strategyId).n;
}

/** Tx hashes of this strategy's own MM legs executed today — used to exclude
 *  the bot's own prints from the external-flow scan (self-crossing guard). */
export function getMmOwnTxHashesToday(strategyId) {
  return db.prepare(`
    SELECT DISTINCT tx_hash FROM mm_trades
    WHERE strategy_id = ? AND tx_hash IS NOT NULL AND created_at >= date('now')
  `).all(strategyId).map((r) => String(r.tx_hash).toLowerCase());
}
