/**
 * gas-ledger.mjs — gas expense tracking for every transaction the app sends.
 *
 * A single `gas_spend` table keyed by tx hash (PRIMARY KEY → the same tx can
 * never be double-counted, no matter how many paths record it). Every buy,
 * sell, exit, approval, wrap, and MM leg flows through one of the shared
 * receipt helpers, which call recordGasForTx() when the receipt lands.
 *
 *   recordGasForTx(txHash, chainKey)   — one tx, idempotent, best-effort
 *   backfillGasFromChain()             — one-time sweep of every historical
 *                                        tx hash already in the DB
 *   getGasTotals() / getGasForHashes() — UI aggregation
 *
 * Receipts come from the chain's HTTP RPC; the USD value uses the chain's own
 * ETH price source (Chainlink mainnet/Base, the ETH/USDG V4 pool on
 * Robinhood) at read time — close enough for expense tracking, and the raw
 * native + gas-unit columns are kept so it can be re-priced later.
 */
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { httpClient, getEthUsdPriceFor } from "./chains.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Load .env if the importing process hasn't already (dashboard.mjs does its own
// loadEnv before our functions run, but standalone/backfill runs need it too —
// without the Alchemy key the RPC falls back to publicnode, which prunes
// receipts and the backfill would miss historical txs).
try {
  for (const line of readFileSync(resolve(__dirname, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "").replace(/\s*#.*$/, "");
  }
} catch { /* no .env — fine */ }
const db = new Database(resolve(__dirname, "data", "accumulate.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS gas_spend (
    tx_hash             TEXT PRIMARY KEY,
    chain               TEXT NOT NULL,
    block_number        INTEGER,
    gas_used            TEXT,
    effective_gas_price TEXT,
    eth_native          REAL,   -- gas cost in the chain's native unit (ETH)
    gas_usd             REAL,   -- USD value of that gas at read time
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const norm = (h) => String(h ?? "").toLowerCase();

/**
 * Record gas for one transaction. Idempotent (INSERT OR IGNORE on the tx
 * hash) and best-effort: any failure logs and returns false rather than
 * throwing — gas accounting must never break a swap flow that already
 * succeeded on-chain.
 */
export async function recordGasForTx(txHash, chainKey = "ethereum", userId = null) {
  const hash = norm(txHash);
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return false;
  try {
    const receipt = await httpClient(chainKey).getTransactionReceipt({ hash });
    if (!receipt) return false; // not mined yet — nothing to record
    const gasUsed = receipt.gasUsed ?? 0n;
    const gasPrice = receipt.effectiveGasPrice ?? receipt.gasPrice ?? 0n;
    const ethNative = Number(gasUsed * gasPrice) / 1e18;
    let gasUsd = null;
    if (ethNative > 0) {
      const ethUsd = await getEthUsdPriceFor(chainKey).catch(() => 0);
      if (ethUsd > 0) gasUsd = ethNative * ethUsd;
    }
    db.prepare(`
      INSERT OR IGNORE INTO gas_spend (tx_hash, chain, block_number, gas_used, effective_gas_price, eth_native, gas_usd, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(hash, chainKey, receipt.blockNumber ?? null, gasUsed.toString(), gasPrice.toString(), ethNative, gasUsd, userId);
    return true;
  } catch (e) {
    console.error(`[gas-ledger] record ${hash.slice(0, 14)}… failed: ${e.message}`);
    return false;
  }
}

/** All-time totals: native units spent on gas and their USD value. */
export function getGasTotals(userId = null) {
  const userFilter = userId ? "WHERE user_id = ?" : "";
  const userParams = userId ? [userId] : [];
  const row = db.prepare(`
    SELECT COALESCE(SUM(eth_native), 0) AS ethNative,
           COALESCE(SUM(gas_usd), 0)    AS usd,
           COUNT(*)                     AS txs
    FROM gas_spend
    ${userFilter}
  `).get(...userParams);
  return { ethNative: row.ethNative ?? 0, usd: row.usd ?? 0, txs: row.txs ?? 0 };
}

/** Gas rows for a set of tx hashes, keyed by lowercase hash (missing hashes absent). */
export function getGasForHashes(hashes) {
  const clean = [...new Set(hashes.map(norm).filter((h) => /^0x[0-9a-f]{64}$/.test(h)))];
  const out = {};
  const CHUNK = 200;
  for (let i = 0; i < clean.length; i += CHUNK) {
    const chunk = clean.slice(i, i + CHUNK);
    const rows = db.prepare(`
      SELECT tx_hash, chain, gas_used, effective_gas_price, eth_native, gas_usd
      FROM gas_spend WHERE tx_hash IN (${chunk.map(() => "?").join(",")})
    `).all(...chunk);
    for (const r of rows) out[r.tx_hash] = r;
  }
  return out;
}

/**
 * Breakdown by chain × product (Sniper | Accumulate | MM | Approvals & other).
 * Product is derived at read time from which trade table holds the tx hash —
 * no extra schema, and re-classification stays correct as history grows.
 * Approvals/wraps don't belong to any trade table → "Approvals & other"
 * (honest bucket rather than silently misattributing them to a product).
 */
export function getGasBreakdown(_legacy = null, userId = null) {
  // Per-user (2026-09-19): gas rows carry user_id (stamped by recordGasForTx/
  // backfillGasFromChain via the owning trade row). Null userId = all users
  // (legacy admin view / pre-stamp rows).
  const userFilter = userId ? "WHERE g.user_id = ?" : "";
  const userParams = userId ? [userId] : [];
  // mm tables may not exist if mm-db.mjs was never imported in this process —
  // the MM EXISTS subqueries are added only when those tables are present.
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
  const hasMm = tables.has("mm_trades") && tables.has("mm_strategies");
  const productExpr = `
    CASE
      WHEN EXISTS (
        -- Our txs only: a dip row's sell_tx_hash is the EXTERNAL whale sell
        -- that triggered the buy, not a transaction we sent (whose gas we
        -- must not count — the whale's $10 gas showed up as ours). Only exit
        -- rows' sell_tx_hash is ours.
        SELECT 1 FROM dip_trades t JOIN dip_watchers w ON w.id = t.watcher_id
        WHERE LOWER(t.buy_tx_hash) = g.tx_hash
           OR (LOWER(t.sell_tx_hash) = g.tx_hash AND t.execution_kind = 'exit')
      ) THEN 'Accumulate'
      WHEN EXISTS (SELECT 1 FROM sniper_trades s WHERE LOWER(s.buy_tx_hash) = g.tx_hash) THEN 'Sniper'
      WHEN EXISTS (SELECT 1 FROM sniper_autosells a WHERE LOWER(a.sell_tx_hash) = g.tx_hash) THEN 'Sniper'
      ${hasMm ? `WHEN EXISTS (
        SELECT 1 FROM mm_trades m JOIN mm_strategies s ON s.id = m.strategy_id
        WHERE LOWER(m.tx_hash) = g.tx_hash AND m.dry_run = 0
      ) THEN 'MM'` : ""}
      ELSE 'Approvals & other'
    END
  `;
  const rows = db.prepare(`
    SELECT g.chain AS chain, ${productExpr} AS product,
           COUNT(*)                    AS txs,
           COALESCE(SUM(g.eth_native), 0) AS eth,
           COALESCE(SUM(g.gas_usd), 0)    AS usd
    FROM gas_spend g
    ${userFilter}
    GROUP BY chain, product
    ORDER BY chain, product
  `).all(...userParams);
  const totals = getGasTotals(userId);
  return { rows, totals };
}

/**
 * One-time backfill: pull receipts for every tx hash already recorded in the
 * trade tables and insert their gas into gas_spend (skips known hashes).
 * Returns { found, recorded, missing } — missing = hashes the chain could
 * not produce a receipt for (dropped/replaced txs, or pruned nodes).
 */
export async function backfillGasFromChain() {
  const pending = db.prepare(`
    SELECT DISTINCT t.tx_hash AS hash, t.chain AS chain, t.user_id AS user_id FROM (
      SELECT buy_tx_hash AS tx_hash, w.chain AS chain, t.user_id AS user_id
        FROM dip_trades t JOIN dip_watchers w ON w.id = t.watcher_id
       WHERE buy_tx_hash IS NOT NULL
      UNION ALL
      -- ONLY exit rows' sell_tx_hash is ours. A dip row's sell_tx_hash is the
      -- EXTERNAL whale sell that triggered the dip — fetching its receipt
      -- recorded whale gas as our spend ($10 IMD row, 2026-09-13).
      SELECT sell_tx_hash, w.chain, t.user_id
        FROM dip_trades t JOIN dip_watchers w ON w.id = t.watcher_id
       WHERE sell_tx_hash IS NOT NULL AND t.execution_kind = 'exit'
      UNION ALL
      SELECT tx_hash, w.chain, s.user_id
        FROM strategy_executions s JOIN dip_watchers w ON w.id = s.watcher_id
       WHERE tx_hash IS NOT NULL AND s.status = 'ok'
      UNION ALL
      SELECT buy_tx_hash, chain, user_id FROM sniper_trades WHERE buy_tx_hash IS NOT NULL
      UNION ALL
      SELECT sell_tx_hash, chain, user_id FROM sniper_autosells WHERE sell_tx_hash IS NOT NULL
      UNION ALL
      SELECT tx_hash, s.chain, m.user_id
       FROM mm_trades m JOIN mm_strategies s ON s.id = m.strategy_id
       WHERE tx_hash IS NOT NULL AND m.dry_run = 0
    ) t WHERE NOT EXISTS (SELECT 1 FROM gas_spend g WHERE g.tx_hash = t.tx_hash)
  `).all();
  let recorded = 0;
  let missing = 0;
  for (const { hash, chain, user_id } of pending) {
    const ok = await recordGasForTx(hash, chain || "ethereum", user_id || null);
    if (ok) recorded += 1; else missing += 1;
  }
  // Stamp owners onto rows recorded BEFORE per-user stamping existed (the
  // user_id column existed but was never populated). Resolve each hash's
  // owner from the trade tables; unknown → left NULL (admin/legacy bucket).
  const unstamped = db.prepare(`
    SELECT tx_hash FROM gas_spend WHERE user_id IS NULL
  `).all();
  const ownerOf = db.prepare(`
    SELECT user_id FROM (
      SELECT user_id, buy_tx_hash AS h FROM sniper_trades WHERE buy_tx_hash IS NOT NULL AND user_id IS NOT NULL
      UNION ALL
      SELECT user_id, sell_tx_hash FROM sniper_trades WHERE sell_tx_hash IS NOT NULL AND user_id IS NOT NULL
      UNION ALL
      SELECT user_id, buy_tx_hash FROM dip_trades WHERE buy_tx_hash IS NOT NULL AND user_id IS NOT NULL
      UNION ALL
      SELECT user_id, sell_tx_hash FROM dip_trades WHERE sell_tx_hash IS NOT NULL AND user_id IS NOT NULL AND execution_kind = 'exit'
      UNION ALL
      SELECT user_id, tx_hash FROM strategy_executions WHERE tx_hash IS NOT NULL AND user_id IS NOT NULL
      UNION ALL
      SELECT user_id, tx_hash FROM mm_trades WHERE tx_hash IS NOT NULL AND user_id IS NOT NULL AND dry_run = 0
    ) WHERE LOWER(h) = ? LIMIT 1
  `);
  let stamped = 0;
  for (const { tx_hash } of unstamped) {
    const owner = ownerOf.get(tx_hash.toLowerCase());
    if (owner?.user_id) {
      db.prepare("UPDATE gas_spend SET user_id = ? WHERE tx_hash = ?").run(owner.user_id, tx_hash);
      stamped += 1;
    }
  }
  if (stamped) console.log(`[gas-ledger] stamped ${stamped}/${unstamped.length} legacy gas rows with their owner`);
  const totals = getGasTotals();
  return { found: pending.length, recorded, missing, totals, stamped };
}
