/**
 * verify-db.mjs — SQLite-backed test checklist for the /verify tab.
 * Own connection to data/accumulate.db (WAL, same as mm-db.mjs).
 *
 * Table `verify_checks`: the full test checklist. Rows are seeded once from
 * VERIFY_SEED (id is a stable slug); re-seeding inserts missing rows only,
 * so status survives restarts and new checklist items appear on upgrade.
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
  CREATE TABLE IF NOT EXISTS verify_checks (
    id         TEXT PRIMARY KEY,
    section    TEXT NOT NULL,
    label      TEXT NOT NULL,
    hint       TEXT,
    status     TEXT NOT NULL DEFAULT 'pending',   -- pending | pass | fail
    note       TEXT,
    updated_at TEXT
  );
`);

export const STATUSES = ["pending", "pass", "fail"];

/** Stable-id checklist. hint = how to test / what "pass" means. */
const VERIFY_SEED = [
  // ── New execution paths (built 2026-09-10) ──────────────────────────────
  { id: "v2factory-fixed", section: "New execution paths", label: "Base V2 factory canonical in both registries",
    hint: "chains.mjs + sniper-swap.mjs both carry 0x8909Dc15…18eC6 (eth_getCode verified). Confirm via a sniper V2 discovery on a known Base V2 token." },
  { id: "v3sell-unwrap-dry", section: "New execution paths", label: "V3 sell unwrap — dry run",
    hint: "estimateGas the new multicall([exactInputSingle, unwrapWETH9]) on a token with a V3 pool (Base or 4663). No funds move." },
  { id: "v3sell-unwrap-live", section: "New execution paths", label: "V3 sell unwrap — live small sell",
    hint: "Exit a small amount through a V3 venue; wallet receives native ETH, NOT WETH (check wallet after tx)." },
  { id: "v4sell-quote", section: "New execution paths", label: "V4 sell quote (executeV4Sell)",
    hint: "Quote a small ATLANTIS sell through its MU pool via the new sniper V4 path — expect >0 quote." },
  { id: "v4sell-live", section: "New execution paths", label: "V4 sell — live small sell",
    hint: "Sell a small clip through a V4 venue via /sniper. Confirm receipt status + quote asset arrives." },
  { id: "mm-snapshot-pricing", section: "New execution paths", label: "MM snapshot pricing (stock-paired pool)",
    hint: "/api/mm/status for ATLANTIS: MU ≈ $900s, ATLANTIS ≈ 0.00002, liquidity ≈ $20K." },
  { id: "mm-engine-tests", section: "New execution paths", label: "MM engine gate tests green",
    hint: "node --test mm.test.mjs → 14/14 (band, alternation, flow-direction, cooldown, caps)." },
  { id: "mm-dry-run-loop", section: "New execution paths", label: "MM dry-run daemon loop",
    hint: "Run a strategy with dry_run=1: decisions logged, mm_trades rows with dry_run=1, no txs sent." },
  { id: "mm-signer-dedicated", section: "New execution paths", label: "Dedicated MM signer resolves",
    hint: "Set MM_PRIVATE_KEY in Settings → MM bot signs from the derived address (shown on the settings card)." },
  { id: "mm-signer-fallback", section: "New execution paths", label: "MM signer falls back cleanly",
    hint: "With MM_PRIVATE_KEY unset, resolveMmSigner returns the shared AGENT_PRIVATE_KEY signer." },

  // ── Regression: Tokens ──────────────────────────────────────────────────
  { id: "tokens-add", section: "Regression — Tokens", label: "Add token (paused, no plan)",
    hint: "Add via /tokens form; status pill shows 'no plan'." },
  { id: "tokens-setplan", section: "Regression — Tokens", label: "Set plan dialog + live preview",
    hint: "Budget split preview warns when dip reserve ~0; save arms the plan." },
  { id: "tokens-editplan", section: "Regression — Tokens", label: "Edit plan carries budget forward",
    hint: "Edit an existing plan: deployed/reserved totals are NOT reset (applyAccumulationStrategy)." },
  { id: "tokens-toggle-guard", section: "Regression — Tokens", label: "Arming planless token rejected",
    hint: "Pause token then Resume: server refuses with 'no plan set'." },
  { id: "tokens-refresh", section: "Regression — Tokens", label: "Refresh position recomputes snapshot",
    hint: "Balance / USD / cost basis / P/L update from on-chain transfer history." },
  { id: "tokens-exit", section: "Regression — Tokens", label: "Exit modal sells + records exit row",
    hint: "Sell % of a balance; dip_trades gets execution_kind='exit' with NEGATIVE token_amount; position refreshes." },
  { id: "tokens-detail-cards", section: "Regression — Tokens", label: "Token detail page degrades gracefully",
    hint: "Open /tokens/:id — cards hide (not crash) when a data source is unavailable." },

  // ── Regression: Zooch ───────────────────────────────────────────────────
  { id: "zooch-review-run", section: "Regression — Zooch", label: "Run a Zooch review end-to-end",
    hint: "Evidence → AI (or heuristic fallback) → proposal + narrative; review completes async." },
  { id: "zooch-apply", section: "Regression — Zooch", label: "Apply proposal creates active plan",
    hint: "Apply from the review; accumulation_strategies row active; replace flow confirms when a plan exists." },
  { id: "zooch-clamps", section: "Regression — Zooch", label: "Rogue AI plan clamped",
    hint: "node --test zooch.test.mjs → 3/3 (incl. deliberately rogue plan)." },
  { id: "zooch-threshold", section: "Regression — Zooch", label: "Dip threshold sanity vs observed sells",
    hint: "With THEGRAPH_API_KEY set: threshold lands near the observed p90-p95 sell size; else heuristic ladder." },

  // ── Regression: Sniper ──────────────────────────────────────────────────
  { id: "sniper-discover", section: "Regression — Sniper", label: "Check liquidity discovers + ranks pools",
    hint: "Paste a token → pools across V2/V3/V4(/Aero on Base) sorted by best quoted output." },
  { id: "sniper-buy", section: "Regression — Sniper", label: "Small live buy",
    hint: "Buy with a chosen pool; tokens arrive; sniper_trades row recorded ok." },
  { id: "sniper-sell-v3", section: "Regression — Sniper", label: "Sell through V3 venue",
    hint: "Native ETH arrives (unwrap multicall); row recorded." },
  { id: "sniper-sell-v4", section: "Regression — Sniper", label: "Sell through V4 venue (new path)",
    hint: "Force-choose a V4 pool: Permit2 approvals fire, UR 0x070b0e swap executes." },
  { id: "sniper-approvals", section: "Regression — Sniper", label: "Approvals card reflects allowances",
    hint: "Refresh allowances; approve a spender; row flips to approved." },
  { id: "sniper-context", section: "Regression — Sniper", label: "Chain switch updates quote context",
    hint: "Toggle Ethereum ↔ Base tab: ethUsd + balances reload." },

  // ── Regression: MM ──────────────────────────────────────────────────────
  { id: "mm-create", section: "Regression — MM", label: "Create strategy (paused + dry-run)",
    hint: "Create for ATLANTIS: venue resolves at create time; row starts paused/dry." },
  { id: "mm-run-dry", section: "Regression — MM", label: "Run in dry-run: decisions logged",
    hint: "Daemon ticks every 20s; blocked-reason or trade rows appear; no chain txs." },
  { id: "mm-live-first-leg", section: "Regression — MM", label: "First LIVE MM leg (small)",
    hint: "Flip dry off, arm, wait for a gated trade; verify tx on Blockscout and inventory update." },
  { id: "mm-realized-pl", section: "Regression — MM", label: "Sell leg updates realized P/L + cost basis",
    hint: "After a live sell: realized_pl_usd moves, inventory_tokens and cost_basis_usd shrink proportionally." },
  { id: "mm-error-autopause", section: "Regression — MM", label: "5 consecutive errors auto-pause",
    hint: "Simulate (e.g. remove liquidity or bad venue) and confirm the strategy pauses itself." },

  // ── Regression: Trades & detail ─────────────────────────────────────────
  { id: "trades-render", section: "Regression — Trades", label: "Trades page renders incl. exits",
    hint: "Exit rows show tx hash, no 'ETH spent'; negative token_amounts don't break the table." },

  // ── Regression: Settings ────────────────────────────────────────────────
  { id: "settings-keys", section: "Regression — Settings", label: "Key save + masked preview",
    hint: "Save AGENT/MM keys via Settings; masked previews show; .env updated." },
  { id: "settings-env-hot", section: "Regression — Settings", label: "Env hot-apply semantics known-good",
    hint: "Dashboard hot-applies its own process.env; daemons need their own restart to see new keys." },

  // ── Regression: Wallet ──────────────────────────────────────────────────
  { id: "wallet-balances", section: "Regression — Wallet", label: "Slideout per-chain balances",
    hint: "ETH + dollar (USDC/USDG) rows per chain; a failing chain shows ⚠ without breaking the panel." },
  { id: "wallet-tokens", section: "Regression — Wallet", label: "Watched-token positions in slideout",
    hint: "Positions come from dip_watchers snapshots (may be stale until Refresh)." },

  // ── Infrastructure ──────────────────────────────────────────────────────
  { id: "infra-tests", section: "Infrastructure", label: "hermes verify recipe passes",
    hint: "hermes verify --json → ok:true." },
  { id: "infra-pm2", section: "Infrastructure", label: "pm2 processes online",
    hint: "accumulate-dashboard + accumulate-watcher online; accumulate-mm-watcher when MM goes live." },
  { id: "infra-funding", section: "Infrastructure", label: "MM wallet funded on 4663",
    hint: "Small ETH amount for gas + trades; balances visible in a block explorer." },
];

function ensureSeed() {
  const insert = db.prepare(`
    INSERT INTO verify_checks (id, section, label, hint)
    VALUES (@id, @section, @label, @hint)
    ON CONFLICT(id) DO NOTHING
  `);
  db.transaction(() => {
    for (const item of VERIFY_SEED) insert.run(item);
  })();
}
ensureSeed();

export function listVerifyChecks() {
  return db.prepare("SELECT * FROM verify_checks ORDER BY id").all();
}

export function setVerifyStatus(id, status, note = null) {
  if (!["pending", "pass", "fail"].includes(status)) throw new Error(`invalid status "${status}"`);
  const row = db.prepare("SELECT id FROM verify_checks WHERE id = ?").get(id);
  if (!row) throw new Error(`unknown check id "${id}"`);
  db.prepare("UPDATE verify_checks SET status = ?, note = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, note, id);
  return db.prepare("SELECT * FROM verify_checks WHERE id = ?").get(id);
}

export function resetVerifySection(section) {
  db.prepare("UPDATE verify_checks SET status = 'pending', note = NULL, updated_at = datetime('now') WHERE section = ?")
    .run(section);
}

export function verifySummary() {
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM verify_checks
  `).get();
}
