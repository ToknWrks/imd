#!/usr/bin/env node
/**
 * dashboard.mjs — Accumulate local dashboard
 * Open: http://localhost:4200
 *
 * Manage dip watchers (token contract, $ threshold, buy amount), view trigger
 * history, and configure the signer (raw key or VultiSig vault). The
 * dip-watcher.mjs daemon polls the DB every 30s to pick up changes made here.
 */
import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { handleSniperRequest } from "./sniper-ui.mjs";
import { startSniperAutoSellLoop } from "./sniper-autosell.mjs";
import { handleMmRequest } from "./mm-ui.mjs";
import { handleVerifyRequest } from "./verify-ui.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, ".env");
const PORT = parseInt(process.env.DASHBOARD_PORT ?? process.env.IMD_DASHBOARD_PORT ?? "4200");

function readEnv() {
  try { return readFileSync(ENV_PATH, "utf8"); } catch { return ""; }
}
function loadEnv() {
  for (const line of readEnv().split("\n")) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "").replace(/\s*#.*$/, "");
  }
}
loadEnv();

function getEnvValue(key) {
  const m = readEnv().match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}
function writeEnvValues(updates) {
  let src = readEnv();
  for (const [key, val] of Object.entries(updates)) {
    if (!val && val !== "false") continue;
    const line = `${key}=${val}`;
    if (new RegExp(`^${key}=`, "m").test(src)) src = src.replace(new RegExp(`^${key}=.*$`, "m"), line);
    else src = src.trimEnd() + "\n" + line + "\n";
  }
  writeFileSync(ENV_PATH, src, "utf8");
  for (const [key, val] of Object.entries(updates)) if (val) process.env[key] = val;
}

import {
  getDipWatchers, getDipWatcher, addDipWatcher, removeDipWatcher, setDipWatcherActive, updateDipWatcherSettings, getDipTrades, setDipWatcherPool,
  updateWalletPosition, applyAccumulationStrategy, getAccumulationStrategy,
  setAccumulationStrategyActive, updateDipWatcherSlippage,
  insertDipTrade, getSniperTrades, reserveStrategyExecution, finalizeStrategyExecution,
  addHoneypotToken, removeHoneypotToken,
} from "./db.mjs";
import { formatUnits } from "viem";
import { getTokenMeta, resolvePoolOverride, buyToken } from "./dip-swap.mjs";
import { WALLET_NAV_BUTTON, WALLET_SLIDEOUT_CSS, walletSlideoutHtml } from "./wallet-slideout.js";
import { WALLET_CONNECT_BUTTON, WALLET_CONNECT_JS } from "./wallet-connect.js";
import { COPILOT_BADGE, COPILOT_JS } from "./copilot-ui.js";
import { APPKIT_SCRIPT } from "./wallet-appkit.js";
import { addSseClient, listPending, listRecent, getRequest, resolveRequest, declineRequest, isCopilotActive, pendingCount } from "./copilot.mjs";
import { handleAuth, sessionAddress } from "./auth.mjs";
import { walletApiHandler } from "./wallet-api.mjs";
import { activateSmartWallet, moveFunds, generateUserSessionKey, getUserWalletStatus } from "./smart-wallet-api.mjs";
import { getUser, setUserField } from "./users.mjs";
import { CHAIN_KEYS, getChain, getEthUsdPriceFor } from "./chains.mjs";
import { getMarketOverview } from "./zooch-data.mjs";
import { listMmStrategies, computeMmPosition } from "./mm-db.mjs";
import { analyzeTechnicals, simulateSellImpact } from "./zooch-analysis.mjs";
import { computeWalletPosition } from "./wallet-position.mjs";
import { resolveSigner } from "./signer.mjs";
import { executeSniperSell } from "./sniper-extras.mjs";
import { getIcon, tokenIconUrl, chainIconUrl } from "./icons.mjs";
import { createVaultStart, verifyVaultFinish, importVaultFile, vaultStatus } from "./vault.mjs";
import { getGasTotals, getGasForHashes, backfillGasFromChain, getGasBreakdown } from "./gas-ledger.mjs";

// ── Shell / CSS ───────────────────────────────────────────────────────────────

const CSS = `
* { box-sizing:border-box; }
body { margin:0; background:#0c0e11; color:#e8eaed; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
header { display:flex; align-items:center; justify-content:space-between; padding:0.85rem 1.5rem; border-bottom:1px solid rgba(255,255,255,0.09); }
.logo { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-weight:600; display:flex; align-items:center; gap:0.5rem; font-size:0.88rem; letter-spacing:0.04em; color:#e8b661; text-transform:uppercase; }
.logo-imd {
  font-family:ui-monospace,"SF Mono",Menlo,monospace;
  font-size:0.88rem;
  font-weight:600;
  line-height:1;
  color:#e8eaed;
  text-transform:uppercase;
  letter-spacing:0.04em;
  margin-left:0.45rem;
  display:inline-block;
}
.logo::before { content:""; display:inline-block; width:8px; height:8px; background:#e8b661; margin-right:0.35rem; }
.nav-links { display:flex; gap:1.4rem; align-items:center; }
.nav-link { color:rgba(255,255,255,0.55); text-decoration:none; font-size:0.82rem; letter-spacing:0.02em; padding:0.25rem 0; border-bottom:2px solid transparent; }
.nav-link.active, .nav-link:hover { color:#e8b661; border-bottom-color:#e8b661; }
main { max-width:1024px; margin:0 auto; padding:2rem 1.5rem 3rem; }
.card { background:#101318; border:1px solid rgba(255,255,255,0.09); border-radius:4px; padding:1.25rem; margin-bottom:1.25rem; }
h1 { font-size:1.25rem; font-weight:600; letter-spacing:-0.01em; margin:0 0 1rem; }
h2 { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:0.72rem; font-weight:600; text-transform:uppercase; letter-spacing:0.12em; color:rgba(232,182,97,0.85); margin:0 0 0.9rem; }
table { width:100%; border-collapse:collapse; font-size:0.84rem; }
th { text-align:left; color:rgba(255,255,255,0.38); font-weight:500; font-size:0.66rem; text-transform:uppercase; letter-spacing:0.09em; padding:0.45rem 0.5rem; border-bottom:1px solid rgba(255,255,255,0.09); }
td { padding:0.55rem 0.5rem; border-bottom:1px solid rgba(255,255,255,0.05); font-variant-numeric:tabular-nums; }
tr.actions-row td { border-bottom:1px solid rgba(255,255,255,0.09); padding:0.5rem 0.5rem 0.85rem; white-space:nowrap; }
tr.actions-row button, tr.actions-row a.pill { margin-right:0.4rem; }
input, select { background:rgba(255,255,255,0.035); border:1px solid rgba(255,255,255,0.12); border-radius:3px; color:#e8eaed; padding:0.5rem 0.6rem; font-size:0.85rem; width:100%; }
input:focus, select:focus { outline:none; border-color:rgba(232,182,97,0.55); box-shadow:0 0 0 2px rgba(232,182,97,0.12); }
label { display:block; font-size:0.72rem; letter-spacing:0.04em; text-transform:uppercase; color:rgba(255,255,255,0.45); margin-bottom:0.35rem; }
.field { margin-bottom:0.9rem; }
.row { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
button { background:#e8b661; color:#0c0e11; border:none; border-radius:3px; padding:0.55rem 1rem; font-weight:600; font-size:0.82rem; cursor:pointer; }
button.secondary { background:transparent; border:1px solid rgba(255,255,255,0.18); color:#e8eaed; }
button.secondary:hover { border-color:rgba(232,182,97,0.5); color:#e8b661; }
button.danger { background:transparent; border:1px solid rgba(248,113,113,0.4); color:#f87171; }
button.danger:hover { border-color:rgba(248,113,113,0.75); background:rgba(248,113,113,0.07); }
dialog { background:#13171d; color:#e8eaed; border:1px solid rgba(255,255,255,0.16); border-radius:4px; padding:1.25rem; width:min(460px, calc(100% - 2rem)); }
dialog::backdrop { background:rgba(5,6,8,0.75); }
.pill { font-size:0.68rem; padding:0.15rem 0.5rem; border-radius:2px; border:1px solid rgba(255,255,255,0.15); font-family:ui-monospace,"SF Mono",Menlo,monospace; letter-spacing:0.04em; }
.pill.on { color:#4ade80; border-color:rgba(74,222,128,0.35); background:rgba(74,222,128,0.06); }
.pill.off { color:rgba(255,255,255,0.4); }
a.button-like { display:inline-block; background:transparent; border:1px solid rgba(232,182,97,0.45); color:#e8b661; border-radius:3px; padding:0.55rem 1rem; font-weight:600; font-size:0.82rem; text-decoration:none; vertical-align:middle; }
a.button-like:hover { background:rgba(232,182,97,0.08); border-color:rgba(232,182,97,0.7); }
tr.actions-row a.button-like { margin-right:0.4rem; }
.hint { font-size:0.76rem; color:rgba(255,255,255,0.35); }
a { color:#e8b661; }
.stat-row { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:1px; background:rgba(255,255,255,0.09); border:1px solid rgba(255,255,255,0.09); border-radius:4px; overflow:hidden; margin-bottom:1.25rem; }
.stat-card { background:#101318; border:none; border-radius:0; padding:1rem 1.1rem; }
.stat-card .label { font-size:0.66rem; text-transform:uppercase; letter-spacing:0.09em; color:rgba(255,255,255,0.38); margin-bottom:0.4rem; }
.stat-card .value { font-size:1.35rem; font-weight:600; font-variant-numeric:tabular-nums; }
.stat-card .sub { font-size:0.76rem; color:rgba(255,255,255,0.45); margin-top:0.2rem; font-variant-numeric:tabular-nums; }
.add-chart-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:1.5rem; align-items:start; }
@media (max-width:760px) { .add-chart-grid { grid-template-columns:1fr; } }
.token-chart-title { font-size:0.66rem; text-transform:uppercase; letter-spacing:0.09em; color:rgba(255,255,255,0.38); margin-bottom:0.7rem; }
.token-chart { display:flex; flex-direction:column; gap:0.5rem; }
.chart-row { display:grid; grid-template-columns:4rem minmax(0,1fr) auto; gap:0.6rem; align-items:center; }
.chart-label { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:0.72rem; letter-spacing:0.04em; color:rgba(255,255,255,0.55); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.chart-track { background:rgba(255,255,255,0.05); border-radius:2px; height:14px; overflow:hidden; }
.chart-bar { height:100%; background:#e8b661; border-radius:2px; }
.chart-value { font-size:0.84rem; font-variant-numeric:tabular-nums; text-align:right; white-space:nowrap; }
.pl-badge { display:inline-block; font-size:0.66rem; padding:0.12rem 0.4rem; border-radius:2px; margin-left:0.45rem; font-family:ui-monospace,"SF Mono",Menlo,monospace; font-variant-numeric:tabular-nums; }
`;

function shell(title, body, active = "") {
  // Phase 2: AppKit universal wallet modal on every page (header Connect).
  const wcProjectId = process.env.WALLET_CONNECT_PROJECT_ID?.trim() || getEnvValue("WALLET_CONNECT_PROJECT_ID");
  const appKitScript = wcProjectId ? APPKIT_SCRIPT(wcProjectId, getChain("ethereum").httpRpc()) : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — Accumulate</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Metal+Mania&display=swap" rel="stylesheet">
  <style>${WALLET_SLIDEOUT_CSS}${CSS}</style>
</head>
<body>
  <header>
    <div class="logo">Accumulate<span class="logo-imd">IMD</span></div>
    <div class="nav-links">
      <a class="nav-link ${active === "overview" ? "active" : ""}" href="/overview">Overview</a>
      <a class="nav-link ${active === "tokens" ? "active" : ""}" href="/tokens">Tokens</a>
      <a class="nav-link ${active === "alpha" ? "active" : ""}" href="/alpha">Alpha</a>
      <a class="nav-link ${active === "sniper" ? "active" : ""}" href="/sniper">Sniper</a>
      <!-- MM hidden: the market-making engine only works on Robinhood Chain (4663),
           which this single-chain mainnet build doesn't trade. The /mm route still
           exists — restore this link if MM ever comes back.
      <a class="nav-link ${active === "mm" ? "active" : ""}" href="/mm">MM</a> -->
      <a class="nav-link ${active === "trades" ? "active" : ""}" href="/trades">Trades</a>
      <a class="nav-link ${active === "settings" ? "active" : ""}" href="/settings">Settings</a>
      ${WALLET_CONNECT_BUTTON}
      ${COPILOT_BADGE}
      ${WALLET_NAV_BUTTON}
    </div>
  </header>
  <main>${body}</main>
  ${walletSlideoutHtml()}
  <div id="cpModalBackdrop" style="display:none"><div id="cpModal"></div></div>
  <script>${WALLET_CONNECT_JS}<\/script>
  <script>${COPILOT_JS}<\/script>
  ${appKitScript}
</body>
</html>`;
}

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

/**
 * Ownership guard for mutation routes (Phase 2 isolation): returns an error
 * string when the session user doesn't own the watcher, else null.
 * Rows with NULL user_id (pre-isolation) are owned by everyone-as-admin —
 * they were backfilled to the first user at startup, so treat NULL as
 * admin-only.
 */
function watcherOwnershipError(req, watcherId) {
  const uid = sessionAddress(req);
  const w = getDipWatcher(watcherId);
  if (!w) return "token not found";
  if (w.user_id && uid && w.user_id !== uid) return "not your token";
  // Rows with NULL user_id are pre-isolation legacy — owned by the first
  // (admin) user once backfilled; until the Users panel exists, allow.
  return null;
}

// ── Pages ─────────────────────────────────────────────────────────────────────

async function isSignerConfigured(userId = null) {
  // Hosted multi-user (2026-09-19): logging in IS connecting a wallet now — a
  // signed-in user always has a valid read context (their own address in
  // co-pilot mode, or their session-key SCW in autonomy mode), regardless of
  // any legacy env-level signer. Only fall through to the env checks below
  // for anonymous/system calls.
  if (userId) return true;
  if (getEnvValue("VAULT_ACTIVE") === "true") {
    const status = await vaultStatus(getEnvValue("VULTISIG_PASS")).catch(() => ({ exists: false }));
    return !!(status.exists && status.address && status.isDeviceShare !== false);
  }
  return !!getEnvValue("AGENT_PRIVATE_KEY") || getEnvValue("SMART_ACCOUNT_ACTIVE") === "true";
}

/** Compute and persist a token's wallet-position snapshot (balance, USD value, cost basis). */
async function computeAndStorePosition(watcher) {
  try {
    // Read walletS per USER (SCW + browser EOA, summed) — copilot users hold
    // launchpad buys in the EOA while app trades land in the SCW; only the
    // combined view is truthful (2026-09-19).
    const { resolveUserReadWallets } = await import("./smart-wallet-api.mjs");
    const readWallets = await resolveUserReadWallets(watcher.user_id, watcher.chain || "ethereum");
    const chainKey = watcher.chain || "ethereum";
    const pos = await computeWalletPosition({
      contractAddress: watcher.contract_address, decimals: watcher.decimals ?? 18, walletAddresses: readWallets, chainKey,
      poolOverride: watcher.pool_address,
    });
    updateWalletPosition(watcher.id, {
      balance: pos.balance, balanceUsd: pos.balanceUsd, priceUsd: pos.priceUsd,
      costBasisUsd: pos.costBasisUsd, unrealizedPlUsd: pos.unrealizedPlUsd, unrealizedPlPct: pos.unrealizedPlPct,
      realizedPlUsd: pos.realizedPlUsd,
    });
  } catch (e) {
    updateWalletPosition(watcher.id, { error: e.message });
  }
}

/** Totals for the /tokens stat cards: value of all tracked tokens, plus
 *  unrealized and realized P/L summed from stored wallet positions. Gas spend
 *  comes from the gas_spend ledger (gas-ledger.mjs) and is subtracted from the
 *  net figures — gas is a real cost of running these strategies. */
function computeWalletSummary(watchers) {
  const num = (v) => (v != null ? Number(v) : 0);
  const tokensUsd = watchers.reduce((sum, w) => sum + num(w.wallet_balance_usd), 0);
  const unrealizedPlUsd = watchers.reduce((sum, w) => sum + num(w.unrealized_pl_usd), 0);
  const realizedPlUsd = watchers.reduce((sum, w) => sum + num(w.realized_pl_usd), 0);
  const positionErrors = watchers.filter((w) => w.position_error).length;
  const gas = getGasTotals();
  return { tokensUsd, unrealizedPlUsd, realizedPlUsd, positionErrors, gas };
}

async function watchersPage(error = "", planWatcherId = null, userId = null) {
  const watchers = getDipWatchers(userId);
  const signerConfigured = await isSignerConfigured(userId);
  const summary = signerConfigured ? computeWalletSummary(watchers) : null;
  // When ?plan=<watcherId> is present (sniper → Accumulate migration), render a
  // hidden data-carrying button for that watcher and auto-click it on load —
  // reuses the exact Set plan modal + save flow, no separate implementation.
  const planTarget = planWatcherId ? watchers.find((w) => w.id === planWatcherId) : null;
  const rows = watchers.map((w) => {
    const strategy = getAccumulationStrategy(w.id);
    const strategyActive = !!strategy?.active;
    const planOwnsSettings = strategyActive;
    const pl = w.unrealized_pl_usd;
    const plStyle = pl == null ? "" : `style="color:${pl >= 0 ? "#4ade80" : "#f87171"}"`;
    const plText = pl == null ? "—" : `${pl >= 0 ? "+" : ""}$${Number(pl).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
      + (w.unrealized_pl_pct != null ? ` (${pl >= 0 ? "+" : ""}${Number(w.unrealized_pl_pct).toFixed(1)}%)` : "");
    return `
    <tr>
      <td><span style="display:inline-flex;align-items:center;gap:0.5rem">
        <img src="${tokenIconUrl(w.chain || "ethereum", w.contract_address, w.symbol)}" alt="" width="22" loading="lazy" style="border-radius:3px;flex-shrink:0" onerror="this.remove()">
        <span>${esc(w.symbol ?? "?")}<br><a href="/tokens/${encodeURIComponent(w.id)}" style="color:inherit;text-decoration:underline;text-decoration-color:rgba(255,255,255,0.25);text-underline-offset:3px"><span class="hint">${w.contract_address.slice(0, 10)}…</span></a></span>
      </span></td>
      <td>${w.wallet_balance != null ? Number(w.wallet_balance).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}</td>
      <td>${w.wallet_balance_usd != null ? "$" + Number(w.wallet_balance_usd).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}</td>
      <td>${w.cost_basis_usd != null ? "$" + Number(w.cost_basis_usd).toLocaleString(undefined, { maximumFractionDigits: 8 }) : (w.position_error ? `<span class="hint" title="${esc(w.position_error)}">n/a</span>` : "—")}</td>
      <td ${plStyle}>${plText}</td>
      <td>${strategy ? "$" + Number(strategy.dip_threshold_usd).toLocaleString() : (w.active ? "$" + Number(w.threshold_usd).toLocaleString() : '<span class="hint">—</span>')}</td>
      <td>${strategy ? money(strategy.base_buy_usd) : (w.active ? "$" + Number(w.buy_amount_usd).toLocaleString() : '<span class="hint">set plan</span>')}</td>
      <td>${w.slippage_pct}%</td>
      <td>${w.cooldown_minutes}m</td>
      <td>${w.last_triggered_at ?? "—"}</td>
      <td><span class="pill ${w.active ? "on" : "off"}" ${!w.active && !getAccumulationStrategy(w.id) ? 'style="color:#e8b661;border-color:rgba(232,182,97,0.4)" title="Set a plan to arm this token"' : ""}>${w.active ? "active" : (getAccumulationStrategy(w.id) ? "paused" : "no plan")}</span></td>
    </tr>
    <tr class="actions-row">
      <td colspan="11">
        ${strategy ? `<div class="hint" style="margin-bottom:0.4rem">
          <strong>${strategyActive ? "Plan" : "Paused plan"}</strong> (${esc(strategy.profile === "manual" ? "manual" : "AI")}) · budget ${money(strategy.total_budget_usd)} · deployed ${money(strategy.deployed_budget_usd)} · base buy ${money(strategy.base_buy_usd)} every ${esc(strategy.cadence_minutes % 1440 === 0 ? (strategy.cadence_minutes / 1440) + " day" + (strategy.cadence_minutes === 1440 ? "" : "s") : strategy.cadence_minutes + " min")} · dip buy ${money(strategy.dip_buy_usd)} after a ${money(strategy.dip_threshold_usd)} sell · dip reserve ${money(strategy.dip_reserve_usd)} · next scheduled ${esc(strategy.next_scheduled_at)} · ends ${esc(strategy.end_at)}
        </div>` : ""}
        <button class="secondary" data-id="${esc(w.id)}" data-pool="${esc(w.pool_address ?? "")}" onclick="openStrategyEditor(this)" ${strategy ? `data-existing="1" data-budget="${Number(strategy.total_budget_usd)}" data-cadence="${strategy.cadence_minutes / 1440}" data-base="${Number(strategy.base_buy_usd)}" data-threshold="${Number(strategy.dip_threshold_usd)}" data-dipbuy="${Number(strategy.dip_buy_usd)}" data-period="${Math.max(1, Math.round((Date.parse(strategy.end_at + "Z") - Date.now()) / 86400000))}" data-slippage="${Number(strategy.slippage_pct)}"` : ""}>${strategy ? "Edit" : "Set plan"}</button>
        ${strategyActive ? `<button class="secondary" onclick="pauseStrategy('${w.id}')">Pause plan</button>` : ""}
        <button class="secondary" onclick="refreshPosition('${w.id}', this)">Refresh</button>
        <button class="secondary" onclick="toggleWatcher('${w.id}', ${w.active ? 0 : 1})">${w.active ? "Pause token" : (getAccumulationStrategy(w.id) ? "Resume token" : "Set plan to arm")}</button>
        <button class="danger" onclick="removeWatcher('${w.id}')">Delete</button>
        <button class="danger" onclick="openExitModal(this)" data-id="${esc(w.id)}" data-symbol="${esc(w.symbol ?? "token")}" data-balance="${w.wallet_balance != null ? Number(w.wallet_balance) : ""}" data-price="${w.price_usd != null ? Number(w.price_usd) : ""}" data-chain="${esc(w.chain || "ethereum")}" data-token="${esc(w.contract_address)}" data-pool="${esc(w.pool_address ?? "")}" ${w.wallet_balance != null && Number(w.wallet_balance) > 0 ? "" : "disabled"}>Exit</button>
      </td>
    </tr>`;
  }).join("");

  return shell("Tokens", `
    
    ${error ? `<div class="card" style="border-color:rgba(248,113,113,0.4);color:#f87171">${esc(error)}</div>` : ""}
    ${!signerConfigured ? `<div class="card" style="border-color:rgba(250,204,21,0.4);background:rgba(250,204,21,0.06)">
      ⚠️ <strong>No wallet configured</strong> — tokens below will not execute any buys until you set a signer.
      <a href="/settings">Configure one in Settings →</a>
    </div>` : summary ? `<div class="stat-row">
      <div class="stat-card">
        <div class="label">Tracked tokens value</div>
        <div class="value">$${summary.tokensUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        <div class="sub">${watchers.length} token${watchers.length === 1 ? "" : "s"}${summary.positionErrors ? ` · ${summary.positionErrors} position error${summary.positionErrors === 1 ? "" : "s"}` : ""}</div>
      </div>
      <div class="stat-card">
        <div class="label">Unrealized P/L</div>
        <div class="value" style="color:${summary.unrealizedPlUsd >= 0 ? "#4ade80" : "#f87171"}">${summary.unrealizedPlUsd >= 0 ? "+" : "−"}$${Math.abs(summary.unrealizedPlUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        <div class="sub">open positions vs cost basis</div>
      </div>
      <div class="stat-card">
        <div class="label">Realized P/L</div>
        <div class="value" style="color:${summary.realizedPlUsd >= 0 ? "#4ade80" : "#f87171"}">${summary.realizedPlUsd >= 0 ? "+" : "−"}$${Math.abs(summary.realizedPlUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        <div class="sub">from exits — refresh positions to update</div>
      </div>
      <div class="stat-card">
        <div class="label">Gas expense <span class="icon-btn" role="button" tabindex="0" title="Gas breakdown by chain and product" onclick="openGasBreakdown()" onkeydown="if(event.key==='Enter')openGasBreakdown()"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.2"/><path d="M8 4.6v4.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.4" r="0.9" fill="currentColor"/></svg></span></div>
        <div class="value" style="color:#f87171">−$${summary.gas.usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        <div class="sub">${summary.gas.txs} tx${summary.gas.txs === 1 ? "" : "s"} · ${summary.gas.ethNative.toFixed(4)} ETH — already netted below</div>
      </div>
      <div class="stat-card">
        <div class="label">Net P/L (after gas)</div>
        <div class="value" style="color:${summary.unrealizedPlUsd + summary.realizedPlUsd - summary.gas.usd >= 0 ? "#4ade80" : "#f87171"}">${summary.unrealizedPlUsd + summary.realizedPlUsd - summary.gas.usd >= 0 ? "+" : "−"}$${Math.abs(summary.unrealizedPlUsd + summary.realizedPlUsd - summary.gas.usd).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        <div class="sub">unrealized + realized − gas</div>
      </div>
    </div>
    <dialog id="gasBreakdownModal">
      <h2>Gas breakdown</h2>
      <p class="hint" id="gasBreakdownMeta"></p>
      <div id="gasBreakdownBody" class="hint">loading…</div>
      <button class="secondary" type="button" onclick="document.getElementById('gasBreakdownModal').close()">Close</button>
    </dialog>
    <script>
      const CHAIN_NAMES = { ${CHAIN_KEYS.map((k) => `"${esc(k)}": "${esc(getChain(k).name)}"`).join(", ")} };
      async function openGasBreakdown() {
        const modal = document.getElementById("gasBreakdownModal");
        const body = document.getElementById("gasBreakdownBody");
        const meta = document.getElementById("gasBreakdownMeta");
        modal.showModal();
        body.textContent = "loading…";
        try {
          const r = await fetch("/api/gas/breakdown");
          const j = await r.json();
          if (!j.ok) { body.textContent = j.error || "failed to load breakdown"; return; }
          meta.textContent = j.totals.txs.toLocaleString() + " transactions · all-time $" + j.totals.usd.toFixed(2) + " · " + j.totals.ethNative.toFixed(5) + " ETH native";
          // Group rows by chain, preserving the API's chain order.
          const byChain = new Map();
          for (const row of j.rows) {
            if (!byChain.has(row.chain)) byChain.set(row.chain, []);
            byChain.get(row.chain).push(row);
          }
          const PRODUCT_COLORS = { Sniper: "#e8b661", Accumulate: "#4ade80", MM: "#60a5fa", "Approvals & other": "rgba(255,255,255,0.45)" };
          let html = "";
          for (const [chain, rows] of byChain) {
            const chainUsd = rows.reduce((s, r) => s + Number(r.usd), 0);
            const chainTxs = rows.reduce((s, r) => s + Number(r.txs), 0);
            html += '<div style="margin-bottom:1rem"><table style="margin-top:0.4rem"><thead><tr><th colspan="2" style="font-size:0.78rem;color:rgba(255,255,255,0.75)">' + (CHAIN_NAMES[chain] || chain) + ' — $' + chainUsd.toFixed(2) + ' · ' + chainTxs.toLocaleString() + ' tx</th></tr>' +
              '<tr><th>Product</th><th style="text-align:right">Spend</th></tr></thead><tbody>';
            for (const row of rows) {
              const share = chainUsd > 0 ? Math.round((Number(row.usd) / chainUsd) * 100) : 0;
              html += '<tr><td><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + (PRODUCT_COLORS[row.product] || "rgba(255,255,255,0.3)") + ';margin-right:0.45rem;vertical-align:middle"></span>' + row.product + '</td>' +
                '<td style="text-align:right">$' + Number(row.usd).toFixed(2) + ' <span class="hint">· ' + share + '% · ' + Number(row.txs).toLocaleString() + ' tx</span></td></tr>';
            }
            html += '</tbody></table></div>';
          }
          body.innerHTML = html || "No gas recorded yet.";
        } catch (e) { body.textContent = e.message; }
      }
    </script>` : ""}
    <div class="card">
      <h2>Add a token</h2>
      <div class="add-chart-grid">
        <form id="addForm" onsubmit="return submitAdd(event)">
          <div class="field">
            <label>Chain</label>
            <select name="chain">${CHAIN_KEYS.map((k) => `<option value="${esc(k)}">${esc(getChain(k).name)}</option>`).join("")}</select>
          </div>
          <div class="field" style="margin-bottom:0.4rem">
            <label>Token contract address</label>
            <input name="contractAddress" placeholder="0x..." required>
          </div>
          <p class="hint" style="margin:0.9rem 0">Adding a token does not arm it — it stays paused until you set a budget. Click <strong>Set plan</strong> on the token's row to configure buys.</p>
          <button type="submit">Add token</button>
        </form>
        <div>
          <div class="token-chart-title">Token value (USD)</div>
          ${watchers.length ? `<div class="token-chart">${watchers.map((w) => {
            const usd = Number(w.wallet_balance_usd ?? 0);
            const maxUsd = Math.max(...watchers.map((x) => Number(x.wallet_balance_usd ?? 0)), 0);
            const pct = maxUsd > 0 ? Math.max(usd > 0 ? 1.5 : 0, (usd / maxUsd) * 100) : 0;
            const pl = w.unrealized_pl_usd == null ? null : Number(w.unrealized_pl_usd);
            return `<div class="chart-row">
              <span class="chart-label" title="${esc(w.symbol ?? w.contract_address)}">${esc(w.symbol ?? "?")}</span>
              <span class="chart-track"><span class="chart-bar" style="display:block;width:${pct.toFixed(1)}%;background:${pl != null && pl < 0 ? "#f87171" : "#e8b661"}"></span></span>
              <span class="chart-value" style="color:${pl != null && pl < 0 ? "#f87171" : "inherit"}">$${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
            </div>`;
          }).join("")}</div>` : `<p class="hint" style="margin:0">No tokens yet — add one to populate the chart.</p>`}
        </div>
      </div>
    </div>
    <div class="card">
      <h2>Tracked tokens</h2>
      <p class="hint">Balance, USD value, and cost basis are read from your wallet's on-chain transfer history — click Refresh to recompute.</p>
      ${watchers.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Token</th><th>Balance</th><th>USD value</th><th>Avg cost/token</th><th>Unrealized P/L</th><th>Sell threshold</th><th>Buy amount</th><th>Slippage</th><th>Cooldown</th><th>Last triggered</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="hint">No tokens yet — add one above.</p>`}
    </div>
    <dialog id="strategyEditor">
      <form onsubmit="return saveStrategy(event)">
        <h2>Accumulation plan</h2>
        <p class="hint">Same machinery as AI plans: a total budget split into scheduled base buys plus a dip reserve that deploys in larger clips after big sells. Budget-exhaustion guardrails apply.</p>
        <input id="strategyWatcherId" type="hidden">
        <div class="row">
          <div class="field"><label>Total budget ($)</label><input id="stratBudget" type="number" min="1" step="0.01" required></div>
          <div class="field"><label>Period (days)</label><input id="stratPeriod" type="number" min="1" max="365" step="1" value="30" required></div>
        </div>
        <div class="row">
          <div class="field"><label>Base buy ($)</label><input id="stratBase" type="number" min="0.01" step="0.01" required></div>
          <div class="field"><label>Every (days)</label><input id="stratCadence" type="number" min="0.02" step="0.02" value="3" required></div>
        </div>
        <div class="row">
          <div class="field"><label>Dip buy ($)</label><input id="stratDipBuy" type="number" min="0.01" step="0.01" required></div>
          <div class="field"><label>After a sell ≥ ($)</label><input id="stratThreshold" type="number" min="0" step="0.01" required></div>
        </div>
        <div class="row">
          <div class="field"><label>Slippage (%)</label><input id="stratSlippage" type="number" min="0.1" max="15" step="0.1" value="3" required></div>
          <div class="field"></div>
        </div>
        <div class="field"><label>Pool override (optional)</label><input id="stratPool" placeholder="auto — or paste V3 pool address / V4 poolId (0x…)">
          <span class="hint">Leave empty for auto-discovery (highest-liquidity V4 pool, V3 fallback). Takes effect within 30s.</span></div>
        <p class="hint" id="stratPreview"></p>
        <button type="submit">Save plan</button>
        <button class="secondary" type="button" onclick="document.getElementById('strategyEditor').close()">Cancel</button>
      </form>
      <script>
        // live preview of the budget split as you type
        document.addEventListener('input', (e) => {
          if (!['stratBudget','stratCadence','stratBase','stratPeriod'].includes(e.target.id)) return;
          const budget = parseFloat(document.getElementById('stratBudget').value);
          const cadence = parseFloat(document.getElementById('stratCadence').value);
          const base = parseFloat(document.getElementById('stratBase').value);
          const period = parseFloat(document.getElementById('stratPeriod').value);
          const el = document.getElementById('stratPreview');
          if (!(budget > 0) || !(cadence > 0) || !(base > 0) || !(period > 0)) { el.textContent = ''; return; }
          const tranches = Math.max(1, Math.ceil(period / cadence));
          const scheduled = base * tranches;
          const reserve = Math.max(0, budget - scheduled);
          const warn = reserve < 1 ? ' — almost no dip reserve!' : '';
          el.textContent = tranches + ' scheduled buys of $' + base.toFixed(2) + ' = $' + scheduled.toFixed(2) + ', dip reserve $' + reserve.toFixed(2) + warn;
        });
      </script>
    </dialog>
    ${(() => {
      if (!planTarget) return "";
      const s = getAccumulationStrategy(planTarget.id);
      return `<button id="planAutoOpen" type="button" style="display:none" data-id="${esc(planTarget.id)}" data-pool="${esc(planTarget.pool_address ?? "")}"
        ${s ? `data-existing="1" data-budget="${Number(s.total_budget_usd)}" data-cadence="${s.cadence_minutes / 1440}" data-base="${Number(s.base_buy_usd)}" data-threshold="${Number(s.dip_threshold_usd)}" data-dipbuy="${Number(s.dip_buy_usd)}" data-period="${Math.max(1, Math.round((Date.parse(s.end_at + "Z") - Date.now()) / 86400000))}" data-slippage="${Number(s.slippage_pct)}"` : `data-existing="0"`}
        onclick="openStrategyEditor(this)"></button>
      <script>
        window.addEventListener('DOMContentLoaded', () => {
          const btn = document.getElementById('planAutoOpen');
          if (btn) { openStrategyEditor(btn); history.replaceState(null, '', '/tokens'); }
        });
      </script>`;
    })()}
    <dialog id="exitModal">
      <form onsubmit="return confirmExit(event)">
        <h2>Exit position</h2>
        <p class="hint" id="exitTokenLine"></p>
        <div class="field">
          <label>Quick % of balance</label>
          <div style="display:flex;gap:0.4rem;flex-wrap:wrap">
            <button type="button" class="secondary" onclick="setExitPct(25)" style="padding:0.35rem 0.8rem">25%</button>
            <button type="button" class="button-like" onclick="setExitPct(50)">50%</button>
            <button type="button" class="button-like" onclick="setExitPct(75)">75%</button>
            <button type="button" class="button-like" onclick="setExitPct(100)">100%</button>
          </div>
        </div>
        <div class="field">
          <label>Amount of tokens to sell</label>
          <input id="exitAmount" type="number" min="0" step="any" oninput="updateExitEstimate()" required>
          <span class="hint" id="exitEstimate"></span>
        </div>
        <div class="field">
          <label>Slippage tolerance (%)</label>
          <input id="exitSlippage" type="number" min="0.1" step="0.1" value="3">
        </div>
        <p class="hint" id="exitStatus"></p>
        <button type="submit" class="danger" id="exitConfirmBtn">Confirm exit — sell</button>
        <button class="secondary" type="button" onclick="document.getElementById('exitModal').close()">Cancel</button>
      </form>
    </dialog>
    <script>
      async function submitAdd(e) {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = Object.fromEntries(fd.entries());
        const r = await fetch('/api/watchers', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const j = await r.json();
        if (!j.ok) { alert(j.error); return; }
        location.reload();
      }
      async function buyNow(btn) {
        const watcherId = location.pathname.split("/")[2];
        const resultEl = document.getElementById("buyNowResult");
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = "Buying…";
        if (resultEl) resultEl.textContent = "";
        try {
          const r = await fetch("/api/watchers/" + watcherId + "/buy-now", { method: "POST" });
          const j = await r.json();
          if (j.ok) {
            if (resultEl) resultEl.innerHTML = '✅ <a href="https://etherscan.io/tx/' + j.txHash + '" target="_blank" rel="noreferrer noopener">' + j.txHash.slice(0, 10) + "…</a> — " + (j.tokenAmount ? j.tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " " + (j.symbol || "") : "sent");
          } else {
            if (resultEl) resultEl.textContent = "✗ " + (j.error || "failed");
            btn.disabled = false;
          }
        } catch (e) {
          if (resultEl) resultEl.textContent = "✗ " + e.message;
          btn.disabled = false;
        }
        btn.textContent = original;
      }
      async function refreshPosition(id, btn) {
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = 'Refreshing…';
        try {
          const r = await fetch('/api/watchers/' + id + '/refresh-position', { method: 'POST' });
          const j = await r.json();
          if (!j.ok) alert(j.error);
        } catch (e) { alert(e.message); }
        location.reload();
      }
      let exitCtx = null;
      function openExitModal(button) {
        const d = button.dataset;
        exitCtx = d;
        document.getElementById('exitTokenLine').textContent =
          d.symbol + ' on ' + d.chain + ' — balance ' + (d.balance || '0') + (d.price ? ' (@ $' + d.price + ')' : '');
        document.getElementById('exitAmount').value = '';
        document.getElementById('exitEstimate').textContent = d.price ? '' : '';
        document.getElementById('exitStatus').textContent = '';
        document.getElementById('exitModal').showModal();
        setExitPct(100);
      }
      function setExitPct(p) {
        if (!exitCtx) return;
        const bal = parseFloat(exitCtx.balance) || 0;
        const amt = bal * p / 100;
        const input = document.getElementById('exitAmount');
        input.value = bal > 0 ? (Math.round(amt * 1e9) / 1e9) : '';
        updateExitEstimate();
      }
      function updateExitEstimate() {
        if (!exitCtx) return;
        const amt = parseFloat(document.getElementById('exitAmount').value) || 0;
        const price = parseFloat(exitCtx.price) || 0;
        const est = document.getElementById('exitEstimate');
        est.textContent = (amt > 0 && price > 0) ? '≈ $' + (amt * price).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' at last known price' : '';
      }
      async function confirmExit(e) {
        e.preventDefault();
        if (!exitCtx) return false;
        const status = document.getElementById('exitStatus');
        const btn = document.getElementById('exitConfirmBtn');
        const amount = document.getElementById('exitAmount').value;
        const slippage = document.getElementById('exitSlippage').value;
        if (!(parseFloat(amount) > 0)) { status.textContent = 'enter an amount'; return false; }
        btn.disabled = true;
        status.textContent = 'selling…';
        try {
          const r = await fetch('/api/watchers/' + encodeURIComponent(exitCtx.id ?? exitCtx.watcherId ?? '') + '/exit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, slippagePct: slippage }) });
          const j = await r.json();
          if (j.ok) {
            status.textContent = 'sold — tx ' + (j.txHash || '').slice(0, 14) + '…';
            setTimeout(() => location.reload(), 1500);
          } else {
            status.textContent = j.error;
            btn.disabled = false;
          }
        } catch (err) {
          status.textContent = err.message;
          btn.disabled = false;
        }
        return false;
      }
      function openStrategyEditor(button) {
        document.getElementById('strategyWatcherId').value = button.dataset.id;
        const existing = button.dataset.existing === '1';
        document.getElementById('stratBudget').value = existing ? button.dataset.budget : '';
        document.getElementById('stratCadence').value = existing ? button.dataset.cadence : '3';
        document.getElementById('stratBase').value = existing ? button.dataset.base : '';
        document.getElementById('stratThreshold').value = existing ? button.dataset.threshold : '';
        document.getElementById('stratDipBuy').value = existing ? button.dataset.dipbuy : '';
        document.getElementById('stratPeriod').value = existing ? button.dataset.period : '30';
        document.getElementById('stratSlippage').value = existing ? button.dataset.slippage : '3';
        document.getElementById('stratPool').value = button.dataset.pool ?? "";
        document.getElementById('strategyEditor').showModal();
      }
      async function saveStrategy(event) {
        event.preventDefault();
        const id = document.getElementById('strategyWatcherId').value;
        const body = {
          totalBudgetUsd: document.getElementById('stratBudget').value,
          cadenceDays: document.getElementById('stratCadence').value,
          baseBuyUsd: document.getElementById('stratBase').value,
          dipThresholdUsd: document.getElementById('stratThreshold').value,
          dipBuyUsd: document.getElementById('stratDipBuy').value,
          periodDays: document.getElementById('stratPeriod').value,
          slippagePct: document.getElementById('stratSlippage').value,
          poolAddress: document.getElementById('stratPool').value.trim(),
          replace: true,
        };
        const response = await fetch('/api/watchers/' + encodeURIComponent(id) + '/strategy', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const result = await response.json();
        if (!result.ok) return alert(result.error);
        location.reload();
      }
      async function pauseStrategy(watcherId) {
        if (!confirm('Pause the accumulation plan for this token? Scheduled buys stop immediately.')) return;
        const response = await fetch('/api/strategies/' + encodeURIComponent(watcherId) + '/toggle', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ active: false }) });
        const result = await response.json();
        if (!result.ok) return alert(result.error);
        location.reload();
      }
      async function toggleWatcher(id, active) {
        await fetch('/api/watchers/' + id + '/toggle', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ active }) });
        location.reload();
      }
      async function removeWatcher(id) {
        if (!confirm('Remove this token?')) return;
        await fetch('/api/watchers/' + id, { method: 'DELETE' });
        location.reload();
      }
    </script>
  `, "tokens");
}

function reportText(value) {
  return typeof value === "string" ? esc(value).replace(/\n/g, "<br>") : "—";
}

function money(value) {
  return value == null ? "—" : `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function sqlNow() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function sqlPlusDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}


function explorerLink(chainKey, kind, value, label) {
  const base = getChain(chainKey || "ethereum").explorer;
  return base ? `<a href="${base}/${kind}/${value}" target="_blank">${label} ↗</a>` : esc(value);
}

// ── Overview page (one card per product + gas) ───────────────────────────────

/** Horizontal bar chart rows (same visual style as the Tokens page chart).
 *  items: [{ label, value, sub, color, plPct }] — widths scale against the max
 *  value. When plPct is set, a color-shaded badge showing the % P/L is appended
 *  to the value cell: green for profit, red for loss, shade deepening with
 *  magnitude (clamped at ±25% for full saturation). */
function overviewChart(items, formatValue = (v) => "$" + v.toLocaleString(undefined, { maximumFractionDigits: 2 })) {
  if (!items.length) return `<p class="hint" style="margin:0">Nothing to show yet.</p>`;
  const fmt = formatValue || ((v) => "$" + v.toLocaleString(undefined, { maximumFractionDigits: 2 }));
  const max = Math.max(...items.map((i) => Math.abs(Number(i.value) || 0)), 0);
  const plBadge = (pct) => {
    if (pct == null || !Number.isFinite(Number(pct))) return "";
    const p = Number(pct);
    // 0 → faint, |pct| ≥ 25% → full shade. Text stays light-on-color.
    const t = Math.min(Math.abs(p) / 25, 1);
    if (p >= 0) {
      const bg = `rgba(74,222,128,${(0.10 + 0.55 * t).toFixed(2)})`;
      const fg = t > 0.55 ? "#0c0e11" : "#4ade80";
      return `<span class="pl-badge" style="background:${bg};color:${fg}">${p >= 0 ? "+" : ""}${p.toFixed(1)}%</span>`;
    }
    const bg = `rgba(248,113,113,${(0.08 + 0.55 * t).toFixed(2)})`;
    return `<span class="pl-badge" style="background:${bg};color:#f87171">−${Math.abs(p).toFixed(1)}%</span>`;
  };
  return `<div class="token-chart">${items.map((i) => {
    const v = Number(i.value) || 0;
    const pct = max > 0 ? Math.max(Math.abs(v) > 0 ? 1.5 : 0, (Math.abs(v) / max) * 100) : 0;
    return `<div class="chart-row">
      <span class="chart-label" title="${esc(i.label)}">${esc(i.label)}</span>
      <span class="chart-track"><span class="chart-bar" style="display:block;width:${pct.toFixed(1)}%;background:${i.color || "#e8b661"}"></span></span>
      <span class="chart-value" style="color:${i.valueColor || "inherit"}">${i.sub != null ? i.sub : fmt(v)}${plBadge(i.plPct)}</span>
    </div>`;
  }).join("")}</div>`;
}

function overviewPage(userId = null) {
  return overviewPageInner(userId);
}

async function overviewPageInner(userId = null) {
  // Per-user (2026-09-19): overview renders the SESSION USER's positions,
  // trades, and gas — same isolation as /tokens and /sniper. Null = legacy
  // all-users view (only for internal calls without a session).
  const watchers = getDipWatchers(userId).filter((w) => Number(w.wallet_balance_usd ?? 0) !== 0 || w.wallet_balance_usd != null);
  // ── Accumulate card: per-token USD wallet value (same chart as /tokens)
  const accItems = watchers
    .map((w) => ({
      label: w.symbol ?? (w.contract_address || "").slice(0, 8),
      value: Number(w.wallet_balance_usd ?? 0),
      pl: w.unrealized_pl_usd,
      plPct: w.unrealized_pl_pct != null ? Number(w.unrealized_pl_pct) : null,
    }))
    .sort((a, b) => b.value - a.value);
  const accCard = `
    <div class="card">
      <h2>Accumulate <a class="hint" href="/tokens" style="float:right;font-size:0.68rem;text-transform:none;letter-spacing:0">open →</a></h2>
      ${overviewChart(accItems.map((i) => ({
        label: i.label, value: i.value, plPct: i.plPct,
        color: i.pl != null && Number(i.pl) < 0 ? "#f87171" : "#e8b661",
      })))}
      <p class="hint" style="margin:0.7rem 0 0">Wallet value per tracked token · ${accItems.length} position${accItems.length === 1 ? "" : "s"} · total $${accItems.reduce((s, i) => s + i.value, 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} · badge = unrealized P/L %</p>
    </div>`;

  // ── Sniper card: realized P/L per chain (buys eth_spent, sells eth_received)
  const sniperByChain = {};
  for (const t of getSniperTrades(200, userId)) {
    const chain = t.chain || "ethereum";
    const b = (sniperByChain[chain] ??= { buys: 0, sells: 0, txs: 0 });
    b.txs += 1;
    b.buys += Number(t.eth_spent ?? 0);
    b.sells += Number(t.eth_received ?? 0);
  }
  const sniperRows = Object.entries(sniperByChain).map(([chain, b]) => {
    const dep = getChain(chain);
    const ethUsdNow = 0; // priced at record time isn't stored per trade; show ETH + live-value both
    return { chain, name: dep.name, ...b };
  });
  const sniperItems = sniperRows.map((r) => {
    const pl = r.sells - r.buys;
    return { chain: r.name, buys: r.buys, sells: r.sells, pl, txs: r.txs };
  });
  const sniperCard = `
    <div class="card">
      <h2>Sniper <a class="hint" href="/sniper" style="float:right;font-size:0.68rem;text-transform:none;letter-spacing:0">open →</a></h2>
      <table style="margin-bottom:0.6rem"><thead><tr><th>Chain</th><th style="text-align:right">Buys</th><th style="text-align:right">Sold for</th><th style="text-align:right">Realized P/L</th></tr></thead><tbody>
        ${sniperItems.length ? sniperItems.map((r) => `<tr>
          <td>${esc(r.chain)}</td>
          <td style="text-align:right">${r.buys.toFixed(4)} ETH <span class="hint">· ${r.txs} tx</span></td>
          <td style="text-align:right">${r.sells.toFixed(4)} ETH</td>
          <td style="text-align:right;color:${r.pl >= 0 ? "#4ade80" : "#f87171"}">${r.pl >= 0 ? "+" : "−"}${Math.abs(r.pl).toFixed(4)} ETH</td>
        </tr>`).join("") : `<tr><td colspan="4" class="hint">No sniper trades yet.</td></tr>`}
      </tbody></table>
      <p class="hint" style="margin:0.7rem 0 0">Realized P/L from completed round-trips (ETH in vs ETH out). Open positions should be none — everything is sold on exit.</p>
    </div>`;

  // ── MM card: inventory breakdown per strategy, same chart style
  const mmItems = listMmStrategies()
    .map((s) => {
      const pos = computeMmPosition(s.id);
      const priceUsd = Number(s.last_price_usd ?? 0);
      const usd = pos.botTokens * priceUsd;
      // Unrealized P/L % of the bot's cost basis (null when nothing is held)
      const plPct = pos.costBasisUsd > 0 ? ((usd - pos.costBasisUsd) / pos.costBasisUsd) * 100 : null;
      return {
        label: `${s.symbol ?? "strategy"}${s.dry_run === 1 ? " (dry)" : ""}`,
        usd,
        pl: pos.realizedPlUsd,
        plPct,
      };
    })
    .filter((i) => i.usd > 0 || i.pl !== 0)
    .sort((a, b) => b.usd - a.usd);
  const mmTotal = mmItems.reduce((s, i) => s + i.usd, 0);
  const mmCard = `
    <div class="card">
      <h2>Market making <a class="hint" href="/mm" style="float:right;font-size:0.68rem;text-transform:none;letter-spacing:0">open →</a></h2>
      ${overviewChart(mmItems.map((i) => ({
        label: i.label, value: i.usd, plPct: i.plPct,
        color: i.pl < 0 ? "#f87171" : "#e8b661",
      })), (v) => "$" + v.toLocaleString(undefined, { maximumFractionDigits: 2 }))}
      <p class="hint" style="margin:0.7rem 0 0">Bot inventory per strategy, valued at last trade price · total $${mmTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}${mmItems.some((i) => i.pl !== 0) ? ` · realized P/L ${mmItems.reduce((s, i) => s + i.pl, 0) >= 0 ? "+" : "−"}$${Math.abs(mmItems.reduce((s, i) => s + i.pl, 0)).toFixed(2)}` : ""} · badge = unrealized P/L % of cost basis</p>
    </div>`;

  // ── Gas card: chain × product breakdown (server-rendered, per user)
  const gas = getGasBreakdown(null, userId);
  const gasCard = `
    <div class="card">
      <h2>Gas expense</h2>
      <p class="hint" style="margin-top:0">${gas.totals.txs.toLocaleString()} transactions · all-time $${gas.totals.usd.toFixed(2)} · ${gas.totals.ethNative.toFixed(5)} ETH</p>
      ${overviewChart(
        gas.rows.map((r) => ({
          label: `${getChain(r.chain).name} · ${r.product}`,
          value: Number(r.usd),
          color: "#e8b661",
        })),
        (v) => "$" + v.toLocaleString(undefined, { maximumFractionDigits: 2 })
      )}
      <p class="hint" style="margin:0.7rem 0 0">All-time gas spend per chain and product — Sniper / Accumulate / MM / Approvals & other.</p>
    </div>`;

  return shell("Overview", `
    
    ${accCard}
    ${sniperCard}
    ${/* mmCard hidden: MM only works on Robinhood Chain (4663), not this mainnet build */ ""}
    ${gasCard}

  `, "overview");
}

function tradesPage(userId = null) {
  const trades = getDipTrades(null, 100, userId);
  // Gas is OUR spend: dip rows' sell_tx_hash is the EXTERNAL whale sell that
  // triggered the dip, not a tx we sent — only exits send a sell tx. Counting
  // trigger txs displayed a whale's $10 gas on our IMD row (2026-09-13).
  const ourHashes = (t) => t.buy_tx_hash ? [t.buy_tx_hash] : (t.execution_kind === "exit" && t.sell_tx_hash ? [t.sell_tx_hash] : []);
  const gasByHash = getGasForHashes(trades.flatMap(ourHashes));
  const gasCell = (t) => {
    const rows = ourHashes(t).map((h) => gasByHash[h.toLowerCase()]).filter(Boolean);
    if (!rows.length) return `<span class="hint" title="no receipt recorded yet — use Backfill gas to pull historical spend">—</span>`;
    const usd = rows.reduce((s, r) => s + (r.gas_usd ?? 0), 0);
    const eth = rows.reduce((s, r) => s + (r.eth_native ?? 0), 0);
    return `<span title="${rows.map((r) => r.gas_used ? Number(r.gas_used).toLocaleString() + " gas units" : "").join(", ")}">$${usd.toFixed(2)} <span class="hint">· ${eth.toFixed(5)} ETH</span></span>`;
  };
  const gasTotal = trades.reduce((s, t) => {
    for (const h of ourHashes(t)) {
      const r = gasByHash[h.toLowerCase()];
      if (r) s += r.gas_usd ?? 0;
    }
    return s;
  }, 0);
  const rows = trades.map((t) => `
    <tr>
      <td>${t.created_at}</td>
      <td>${esc(t.symbol ?? t.contract_address)}</td>
      <td>$${t.sell_usd ? Number(t.sell_usd).toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}</td>
      <td>${t.eth_spent ? Number(t.eth_spent).toFixed(4) + " ETH" : "—"}</td>
      <td>${t.token_amount ? Number(t.token_amount).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}</td>
      <td>${gasCell(t)}</td>
      <td><span class="pill ${t.status === "ok" ? "on" : "off"}" style="${t.status !== "ok" ? "color:#f87171;border-color:rgba(248,113,113,0.3)" : ""}">${t.status}</span></td>
      <td>${t.buy_tx_hash ? explorerLink(t.chain, "tx", t.buy_tx_hash, "view") : (t.error ? `<span class="hint" title="${esc(t.error)}">error</span>` : "—")}</td>
    </tr>`).join("");

  return shell("Trades", `
    <h1>Trigger &amp; Trade History</h1>
    <div class="card">
      <p class="hint" style="margin-top:0">Gas shown is what the wallet paid per transaction (gas units × effective gas price, valued at the chain's ETH price). <button class="secondary" style="padding:0.2rem 0.6rem;font-size:0.72rem" onclick="backfillGas(this)">Backfill gas</button> <span id="gasBackfillStatus" class="hint"></span></p>
      ${trades.length ? `<table><thead><tr><th>When</th><th>Token</th><th>Sell detected</th><th>ETH spent</th><th>Tokens bought</th><th>Gas</th><th>Status</th><th>Tx</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="hint" style="margin-bottom:0">Gas on this page (last ${trades.length} trades): $${gasTotal.toFixed(2)} — all-time totals live on the Tokens page.</p>` : `<p class="hint">No trades yet.</p>`}
    </div>
    <script>
      async function backfillGas(btn) {
        btn.disabled = true;
        const el = document.getElementById("gasBackfillStatus");
        el.textContent = "pulling receipts from the chain…";
        try {
          const r = await fetch("/api/gas/backfill", { method: "POST" });
          const j = await r.json();
          if (j.ok) {
            el.textContent = "recorded " + j.recorded + " tx" + (j.recorded === 1 ? "" : "s") + " · all-time gas $" + j.totals.usd.toFixed(2) + (j.missing ? " · " + j.missing + " unavailable" : "");
            setTimeout(() => location.reload(), 1800);
          } else { el.textContent = j.error || "failed"; btn.disabled = false; }
        } catch (e) { el.textContent = e.message; btn.disabled = false; }
      }
    </script>
  `, "trades");
}

/** Token detail page: plan, market snapshot, technicals, impact, trades. */
async function tokenDetailPage(watcherId, userId = null) {
  const w = getDipWatcher(watcherId);
  if (!w) return null;
  if (userId && w.user_id && w.user_id !== userId) return null; // isolation: another user's token
  const strategy = getAccumulationStrategy(w.id);
  const trades = getDipTrades(w.id, 15);
  const signerConfigured = await isSignerConfigured(userId);
  let market = null, tech = null, impact = null;
  const chainKey = w.chain || "ethereum";
  try { market = (await getMarketOverview(w.contract_address, chainKey))[0] ?? null; } catch {}
  try { tech = (await analyzeTechnicals(w.contract_address, 30, chainKey)).technicals; } catch {}
  try { impact = await simulateSellImpact(w.contract_address, w.decimals ?? 18, undefined, chainKey); } catch {}

  const priceChangePill = (pct) => pct == null ? "" :
    `<span class="pill ${pct >= 0 ? "on" : "off"}" style="margin-left:0.4rem">${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%</span>`;

  const stats = `
    <div class="stat-row">
      <div class="stat-card"><div class="label">Price</div><div class="value">${market?.priceUsd != null ? money(market.priceUsd) : "—"}${priceChangePill(market?.priceChange?.h24)}</div><div class="sub">24h · 1h ${market?.priceChange?.h1 != null ? (market.priceChange.h1 >= 0 ? "+" : "") + market.priceChange.h1.toFixed(1) + "%" : "—"}</div></div>
      <div class="stat-card"><div class="label">Your position</div><div class="value">${w.wallet_balance != null ? Number(w.wallet_balance).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"} ${esc(w.symbol ?? "")}</div><div class="sub">${w.wallet_balance_usd != null ? money(w.wallet_balance_usd) : "—"}${w.unrealized_pl_usd != null ? ` · unrealized <span style="color:${w.unrealized_pl_usd >= 0 ? "#4ade80" : "#f87171"}">${w.unrealized_pl_usd >= 0 ? "+" : ""}${money(Math.abs(w.unrealized_pl_usd))}</span> (${w.unrealized_pl_pct >= 0 ? "+" : ""}${Number(w.unrealized_pl_pct).toFixed(1)}%)` : ""}${Number(w.realized_pl_usd ?? 0) !== 0 ? ` · realized <span style="color:${w.realized_pl_usd >= 0 ? "#4ade80" : "#f87171"}">${w.realized_pl_usd >= 0 ? "+" : ""}${money(Math.abs(w.realized_pl_usd))}</span>` : ""}</div></div>
      <div class="stat-card"><div class="label">Liquidity</div><div class="value">${market?.liquidityUsd != null ? money(market.liquidityUsd) : "—"}</div><div class="sub">${market?.isV4 ? "Uniswap V4" : esc(market?.dex ?? "—")} ${market?.quoteSymbol ? "· " + esc(market.quoteSymbol) : ""}</div></div>
      <div class="stat-card"><div class="label">24h volume</div><div class="value">${market?.volume?.h24 != null ? money(market.volume.h24) : "—"}</div><div class="sub">${market?.txns?.h24 ? `${market.txns.h24.buys.toLocaleString()} buys / ${market.txns.h24.sells.toLocaleString()} sells` : "—"}</div></div>
    </div>`;

  const planCard = strategy ? `
    <div class="card">
      <h2>Accumulation plan <span class="pill ${strategy.active ? "on" : "off"}">${strategy.active ? "active" : "paused"}</span> <span class="hint">(${strategy.profile === "manual" ? "manual" : "AI-planned"})</span></h2>
      <div class="stat-row">
        <div class="stat-card"><div class="label">Budget</div><div class="value">${money(strategy.total_budget_usd)}</div><div class="sub">deployed ${money(strategy.deployed_budget_usd)} · ${strategy.total_budget_usd > 0 ? Math.round((strategy.deployed_budget_usd / strategy.total_budget_usd) * 100) : 0}% used</div></div>
        <div class="stat-card"><div class="label">Base buy</div><div class="value">${money(strategy.base_buy_usd)}</div><div class="sub">every ${strategy.cadence_minutes % 1440 === 0 ? (strategy.cadence_minutes / 1440) + "d" : strategy.cadence_minutes + "m"} · next ${esc(strategy.next_scheduled_at)}</div></div>
        <div class="stat-card"><div class="label">Dip buy</div><div class="value">${money(strategy.dip_buy_usd)}</div><div class="sub">after a ${money(strategy.dip_threshold_usd)} sell</div></div>
        <div class="stat-card"><div class="label">Dip reserve</div><div class="value">${money(strategy.dip_reserve_usd)}</div><div class="sub">ends ${esc(strategy.end_at)}</div></div>
      </div>
      <div style="margin-top:0.8rem;display:flex;gap:0.6rem;align-items:center">
        <button class="button-like" id="buyNowBtn" onclick="(async (btn)=>{const watcherId=location.pathname.split('/')[2];const resultEl=document.getElementById('buyNowResult');btn.disabled=true;const original=btn.textContent;btn.textContent='Buying…';if(resultEl)resultEl.textContent='';try{const r=await fetch('/api/watchers/'+watcherId+'/buy-now',{method:'POST'});const j=await r.json();if(j.ok){if(resultEl)resultEl.innerHTML='✅ <a href=\'https://etherscan.io/tx/'+j.txHash+'\' target=\'_blank\' rel=\'noreferrer noopener\'>'+j.txHash.slice(0,10)+'…</a> — '+(j.tokenAmount?j.tokenAmount.toLocaleString(undefined,{maximumFractionDigits:0})+' '+(j.symbol||''):'sent');}else{if(resultEl)resultEl.textContent='✗ '+(j.error||'failed');btn.disabled=false;}}catch(e){if(resultEl)resultEl.textContent='✗ '+e.message;btn.disabled=false;}btn.textContent=original;})(this)" ${strategy.active ? "" : "disabled title=\"plan is paused — resume it first\""}>Buy now (${money(strategy.base_buy_usd)})</button>
        <span id="buyNowResult" class="hint"></span>
      </div>
    </div>` : `<div class="card hint">No accumulation plan yet — set one from the <a href="/tokens">Tokens</a> page.</div>`;

  const impactCard = impact?.points?.length ? `
    <div class="card">
      <h2>Price impact <span class="hint">(simulated sells through the live pool)</span></h2>
      <table><thead><tr><th>Sell size</th><th>Price move</th></tr></thead><tbody>
        ${impact.points.map((p) => `<tr><td>${money(p.sellUsd)}</td><td>${p.impactPct != null ? `<strong>${p.impactPct}%</strong>` : "beyond depth"}</td></tr>`).join("")}
      </tbody></table>
    </div>` : "";

  const techCard = tech && !tech.error ? `
    <div class="card">
      <h2>Chart technicals <span class="hint">(daily candles)</span></h2>
      <div class="stat-row">
        <div class="stat-card"><div class="label">Trend</div><div class="value">${esc(tech.trend ?? "—")}</div><div class="sub">RSI(14) ${tech.rsi14 ?? "—"}</div></div>
        <div class="stat-card"><div class="label">SMA7 / SMA20</div><div class="value" style="font-size:0.95rem">${tech.sma7 != null ? money(tech.sma7) : "—"} / ${tech.sma20 != null ? money(tech.sma20) : "—"}</div><div class="sub">SMA50 ${tech.sma50 != null ? money(tech.sma50) : "—"}</div></div>
        <div class="stat-card"><div class="label">Realized vol</div><div class="value">${tech.realizedVolPctDaily ?? "—"}%/day</div><div class="sub">max drawdown ${tech.maxDrawdownPct ?? "—"}%</div></div>
        <div class="stat-card"><div class="label">7d change</div><div class="value">${tech.change7dPct != null ? (tech.change7dPct >= 0 ? "+" : "") + tech.change7dPct + "%" : "—"}</div><div class="sub">30d ${tech.change30dPct != null ? (tech.change30dPct >= 0 ? "+" : "") + tech.change30dPct + "%" : "—"}</div></div>
      </div>
    </div>` : "";

  // OUR txs only (see tradesPage) — dip rows' sell_tx_hash is the external trigger.
  const gasByHash = getGasForHashes(trades.flatMap((t) => t.buy_tx_hash ? [t.buy_tx_hash] : (t.execution_kind === "exit" && t.sell_tx_hash ? [t.sell_tx_hash] : [])));
  const tradesCard = trades.length ? `
    <div class="card">
      <h2>Trade history</h2>
      <table><thead><tr><th>When</th><th>Kind</th><th>Sell detected</th><th>ETH spent</th><th>Tokens bought</th><th>Gas</th><th>Status</th><th>Tx</th></tr></thead><tbody>
        ${trades.map((t) => {
          const gasRows = (t.buy_tx_hash ? [t.buy_tx_hash] : (t.execution_kind === "exit" && t.sell_tx_hash ? [t.sell_tx_hash] : [])).map((h) => gasByHash[h.toLowerCase()]).filter(Boolean);
          const gasUsd = gasRows.reduce((s, r) => s + (r.gas_usd ?? 0), 0);
          return `<tr>
          <td>${esc(t.created_at)}</td>
          <td>${t.execution_kind === "test" ? "test" : t.execution_kind === "scheduled" ? "scheduled" : t.sell_tx_hash ? "dip" : "manual"}</td>
          <td>${t.sell_usd != null ? money(t.sell_usd) : "—"}</td>
          <td>${t.eth_spent != null ? Number(t.eth_spent).toFixed(4) : "—"}</td>
          <td>${t.token_amount != null ? Number(t.token_amount).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}</td>
          <td>${gasRows.length ? `<span style="color:#f87171">−$${gasUsd.toFixed(2)}</span>` : `<span class="hint">—</span>`}</td>
          <td><span class="pill ${t.status === "ok" ? "on" : "off"}">${esc(t.status)}</span>${t.error ? ` <span class="hint" title="${esc(t.error)}">ⓘ</span>` : ""}</td>
          <td>${t.buy_tx_hash ? explorerLink(w.chain, "tx", t.buy_tx_hash, "view") : "—"}</td>
        </tr>`;
        }).join("")}
      </tbody></table>
    </div>` : `<div class="card hint">No trades yet.</div>`;

  return shell(`${w.symbol ?? "Token"} — Accumulate`, `
    <div style="display:flex;align-items:baseline;gap:0.75rem;flex-wrap:wrap">
      <h1 style="margin:0;display:flex;align-items:center;gap:0.6rem">
        <img src="${tokenIconUrl(w.chain || "ethereum", w.contract_address, w.symbol)}" alt="" width="28" height="28" style="border-radius:4px" onerror="this.remove()">
        <span>${esc(w.symbol ?? "Token")} <span class="hint" style="font-size:0.85rem">${w.contract_address.slice(0, 6)}…${w.contract_address.slice(-4)} · ${explorerLink(w.chain, "token", w.contract_address, "explorer")}</span></span>
      </h1>
      <span class="pill ${w.active ? "on" : "off"}">${w.active ? "watching" : "paused"}</span>
      ${!signerConfigured ? `<span class="pill off">no wallet</span>` : ""}
      ${w.pool_address ? `<span class="hint">pool override set</span>` : ""}
    </div>
    ${stats}
    ${planCard}
    <div class="card">
      <h2>Trigger & execution</h2>
      <div class="stat-row">
        <div class="stat-card"><div class="label">Dip trigger</div><div class="value">${money(w.threshold_usd)}</div><div class="sub">manual fallback · cooldown ${w.cooldown_minutes}m · slippage ${w.slippage_pct}%</div></div>
        <div class="stat-card"><div class="label">Last triggered</div><div class="value" style="font-size:0.95rem">${esc(w.last_triggered_at ?? "never")}</div><div class="sub">${strategy?.active ? "plan dip trigger " + money(strategy.dip_threshold_usd) : "no plan — manual settings only"}</div></div>
        <div class="stat-card"><div class="label">Pool</div><div class="value" style="font-size:0.95rem">${w.pool_address ? w.pool_address.slice(0, 10) + "…" : "auto"}</div><div class="sub">override or best-liquidity discovery</div></div>
        <div class="stat-card"><div class="label">Avg cost/token</div><div class="value">${w.cost_basis_usd != null ? "$" + Number(w.cost_basis_usd).toLocaleString(undefined, { maximumFractionDigits: 8 }) : "—"}</div><div class="sub">${w.position_error ? esc(w.position_error) : "from wallet transfer history"}</div></div>
      </div>
    ${techCard}
    ${impactCard}
    ${tradesCard}
  `, "tokens");
}

async function settingsPage(vaultMsg = "", userId = null) {
  const vaultActive = getEnvValue("VAULT_ACTIVE") === "true";
  const status = await vaultStatus(getEnvValue("VULTISIG_PASS")).catch((e) => ({ exists: false, error: e.message }));
  const pk = getEnvValue("AGENT_PRIVATE_KEY");
  const pkMasked = pk ? pk.slice(0, 6) + "…" + pk.slice(-4) : "";
  const alchemyKey = getEnvValue("ALCHEMY_API_KEY");
  const openAiKey = getEnvValue("OPENAI_API_KEY");
  const openAiModel = getEnvValue("OPENAI_MODEL") || "openai-gpt-4o-mini-2024-07-18";
  const theGraphKey = getEnvValue("THEGRAPH_API_KEY");
  const uniswapKey = getEnvValue("UNISWAP_API_KEY");
  const mmPk = getEnvValue("MM_PRIVATE_KEY");
  const mmPkMasked = mmPk ? mmPk.slice(0, 6) + "…" + mmPk.slice(-4) : "";
  let mmAddress = "";
  if (mmPk) {
    try {
      const { privateKeyToAccount } = await import("viem/accounts");
      mmAddress = privateKeyToAccount(mmPk.startsWith("0x") ? mmPk : "0x" + mmPk).address;
    } catch { mmAddress = ""; }
  }
  // Smart-account mode state: session key presence + derived SCW address.
  const smartActive = getEnvValue("SMART_ACCOUNT_ACTIVE") === "true";
  const copilotOn = isCopilotActive();
  const copilotConnected = userId; // your own login address IS the co-pilot wallet now
  // Per-user signer state (Phase 2): mode + key presence from the users table.
  let userMode = "copilot";
  let userHasSessionKey = false;
  if (userId) {
    const { getUser } = await import("./users.mjs");
    const u = getUser(userId);
    if (u) { userMode = u.signer_mode || "copilot"; userHasSessionKey = !!u.session_key_enc; }
  }
  const aaSessionKey = getEnvValue("AA_SESSION_KEY");
  let smartAddress = "";
  let smartModeNote = "";
  if (aaSessionKey) {
    try {
      const { buildSmartAccountSigner } = await import("./smart-account.mjs");
      process.env.SMART_ACCOUNT_ACTIVE = "true";   // ensure the branch engages for derivation
      const s = await buildSmartAccountSigner("ethereum");
      smartAddress = s.address;
    } catch (e) {
      smartModeNote = String(e.message).slice(0, 140);
    }
  }

  return shell("Settings", `
    <h1>Settings</h1>
    ${vaultMsg ? `<div class="card">${vaultMsg}</div>` : ""}

    <div class="card">
      <h2>Signer</h2>
      <p class="hint"><b>Default:</b> the wallet connected in the header (${copilotConnected ? `<code>${copilotConnected.slice(0, 6)}…${copilotConnected.slice(-4)}</code>` : "none connected yet — click Connect wallet above"}). In <b>Co-pilot</b> mode it approves every trade. Optionally generate a <b>smart wallet</b> below for autonomous trading — its session key is stored encrypted on this server, and it signs trades without waiting for you.</p>
      <div id="smartFields">
        <div id="userWalletBox">
          <p class="hint">Loading your trading wallet…</p>
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
          <button onclick="generateUserKey(this)">${"Generate a session key"}</button>
          <button class="secondary" onclick="regenerateUserKey(this)" title="Derives a NEW address — sweep funds out of the old one first.">Regenerate key</button>
        </div>
        <div id="userKeyGenResult" style="display:none;margin-top:0.6rem;padding:0.6rem 0.7rem;background:rgba(74,222,128,0.07);border:1px solid rgba(74,222,128,0.3);border-radius:4px">
          <p class="hint" style="margin:0 0 0.4rem"><b style="color:#4ade80">Session key generated and stored (encrypted).</b> Back it up NOW — it is shown only once:</p>
          <code id="userGenKey" style="display:block;word-break:break-all;font-size:0.72rem;color:#e8eaed;user-select:all"></code>
          <p class="hint" style="margin:0.4rem 0 0">Your smart account: <code id="userGenAddr"></code> — fund it with your plan budget + gas. Same key = same address, always.</p>
        </div>
        <p class="hint" style="margin-top:0.8rem">Uses the platform ALCHEMY_API_KEY for the bundler/RPC. Your session key is stored AES-256-GCM encrypted; back it up when shown — it is a wallet seed. Pick your trading mode in the <b>Trading mode</b> card below.</p>
      </div>
    </div>

    <div class="card">
      <h2>Trading mode</h2>
      <p class="hint"><b>Autonomy</b> — your own smart wallet (session key) trades automatically. <b>Co-pilot</b> — every trade (dip, sniper, and MM) waits for your approval: the dashboard pops an approval modal, your connected browser wallet signs it, and anything you don't approve in time is <b>skipped and logged</b> — never traded without explicit approval.</p>
      <div class="field"><label>Your mode</label>
        <select id="copilotMode">
          <option value="off" ${userMode === "autonomy" ? "selected" : ""}>Autonomy — trade automatically (your session key)</option>
          <option value="on" ${userMode === "copilot" ? "selected" : ""}>Co-pilot — approve every trade in the browser</option>
        </select>
      </div>
      ${userMode === "autonomy" && !userHasSessionKey ? `<p class="hint" style="color:#f87171">⚠ Autonomy selected but no session key stored — generate one in the Signer section above, then save again.</p>` : ""}
      ${userMode === "autonomy" && userHasSessionKey ? `<p class="hint">✓ Autonomy active — trades sign with your session key.</p>` : ""}
      ${userMode === "copilot" ? `<p class="hint">✓ Co-pilot active — keep a dashboard tab open. Requests also appear on the ⏳ badge in the header. Timeout: <code>COPILOT_TIMEOUT_S</code> (default 90s).</p>` : ""}
      <button onclick="saveCopilotMode(this)">Save trading mode</button>
    </div>

    <div class="card">
      <h2>Market Maker wallet</h2>
      <p class="hint">Optional dedicated hot wallet for the MM bot — its ETH and token inventory stay fully segregated from the dip strategies. Leave blank to have the MM bot share the main AGENT_PRIVATE_KEY signer. Key never leaves this machine.</p>
      <div class="field"><label>MM_PRIVATE_KEY (0x-prefixed)</label><input id="mmPk" type="password" placeholder="${mmPkMasked || "0x..."}"></div>
      <button onclick="saveMmKey()">Save MM key</button>
      ${mmPk ? `<p class="hint" style="margin-top:0.5rem">MM bot signs from <code>${mmAddress}</code> (dedicated)</p>` : `<p class="hint" style="margin-top:0.5rem">MM bot currently shares the main signer.</p>`}
    </div>

    <div class="card">
      <h2>RPC</h2>
      <p class="hint">Alchemy API key — required for the real-time WebSocket subscription that watches Uniswap Swap events on mainnet.</p>
      <div class="field"><label>ALCHEMY_API_KEY</label><input id="alchemyKey" type="password" placeholder="${alchemyKey ? alchemyKey.slice(0, 6) + "…" : ""}"></div>
      <button onclick="saveAlchemy()">Save</button>
    </div>

    <div class="card">
      <h2>Uniswap Indexer</h2>
      <p class="hint">Two independent keys. The <strong>Uniswap API key</strong> unlocks smart cross-pool routing and quoting (V2/V3/V4 in one call) for better buy execution. Both optional. Keys: <a href="https://developers.uniswap.org/dashboard" target="_blank">developers.uniswap.org/dashboard</a> · <a href="https://thegraph.com/studio/apikeys/" target="_blank">thegraph.com/studio/apikeys</a></p>
      <div class="row">
        <div class="field"><label>UNISWAP_API_KEY (Trading API)</label><input id="uniswapApiKey" type="password" placeholder="${uniswapKey ? uniswapKey.slice(0, 6) + "…" : ""}"></div>
        <div class="field"><label>THEGRAPH_API_KEY (Graph Studio)</label><input id="theGraphKey" type="password" placeholder="${theGraphKey ? theGraphKey.slice(0, 6) + "…" : ""}"></div>
      </div>
      <button onclick="saveIndexerKeys()">Save</button>
    </div>

    <script>
      async function buyNow(btn) {
        const watcherId = location.pathname.split("/")[2];
        const resultEl = document.getElementById("buyNowResult");
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = "Buying…";
        if (resultEl) resultEl.textContent = "";
        try {
          const r = await fetch("/api/watchers/" + watcherId + "/buy-now", { method: "POST" });
          const j = await r.json();
          if (j.ok) {
            if (resultEl) resultEl.innerHTML = '✅ <a href="https://etherscan.io/tx/' + j.txHash + '" target="_blank" rel="noreferrer noopener">' + j.txHash.slice(0, 10) + "…</a> — " + (j.tokenAmount ? j.tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " " + (j.symbol || "") : "sent");
          } else {
            if (resultEl) resultEl.textContent = "✗ " + (j.error || "failed");
            btn.disabled = false;
          }
        } catch (e) {
          if (resultEl) resultEl.textContent = "✗ " + e.message;
          btn.disabled = false;
        }
        btn.textContent = original;
      }

      // ── Per-user trading wallet (session key + SCW) ──────────────────────
      async function loadUserWallet() {
        const box = document.getElementById('userWalletBox');
        try {
          const r = await fetch('/api/user/wallet');
          if (r.status === 401) { location.reload(); return; }
          const j = await r.json();
          if (!j.ok) { box.innerHTML = '<p class="hint" style="color:#f87171">' + (j.error || 'unavailable') + '</p>'; return; }
          if (!j.hasKey) {
            box.innerHTML = '<p class="hint">No session key yet — click <b>Generate a session key</b> below. Your key derives YOUR OWN smart account; fund that address with your plan budget + gas.</p>'
              + '<p class="hint">Current mode: <b>' + (j.signerMode || 'copilot') + '</b> — change it in the Trading mode card below.</p>';
            return;
          }
          box.innerHTML =
            '<p>✓ Your smart account — <code>' + j.address + '</code></p>' +
            '<p class="hint">Balance: ' + j.eth.toFixed(6) + ' ETH' + (j.usd != null ? ' · ' + j.usd.toFixed(2) + ' USD' : '') + ' · ' + (j.deployed ? 'deployed' : 'not yet deployed (first trade deploys it)') + '</p>' +
            '<p class="hint">Fund THIS address from the wallet slideout. Same key = same address, always.</p>' +
            '<p class="hint">Current mode: <b>' + (j.signerMode || 'copilot') + '</b> — change it in the Trading mode card below.</p>';
        } catch (e) {
          box.innerHTML = '<p class="hint" style="color:#f87171">' + (e.message || e) + '</p>';
        }
      }
      async function generateUserKey(btn) {
        if (!confirm('Generate a session key? It is stored encrypted on the server and shown ONCE below — back it up immediately. It is a wallet seed.')) return;
        btn.disabled = true; btn.textContent = 'Generating…';
        try {
          const r = await fetch('/api/user/session-key', { method:'POST', headers:{'Content-Type':'application/json'}, body: '{}' });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || j.message || 'generation failed');
          document.getElementById('userGenKey').textContent = j.sessionKey;
          document.getElementById('userGenAddr').textContent = j.address;
          document.getElementById('userKeyGenResult').style.display = '';
          btn.textContent = 'Regenerate key';
          loadUserWallet();
        } catch (e) {
          alert('Generation failed: ' + (e.message || e));
        } finally { btn.disabled = false; }
      }
      async function regenerateUserKey(btn) {
        if (!confirm('Regenerate? Your NEW smart account is a different address. Sweep funds out of the old account first (wallet slideout → Move out).')) return;
        btn.disabled = true; btn.textContent = 'Generating…';
        try {
          let r = await fetch('/api/user/session-key', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({}) });
          let j = await r.json();
          if (!j.ok && j.blocked === 'funds-present') {
            if (!confirm(j.message + '\\n\\nOverride and generate anyway? The old account stays owned by your old key backup (recoverable), but the app will track the new empty account.')) { btn.disabled = false; btn.textContent = 'Regenerate key'; return; }
            r = await fetch('/api/user/session-key', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ force: true }) });
          }
          const j2 = await r.json();
          if (!j2.ok) throw new Error(j2.error || j2.message || 'generation failed');
          document.getElementById('userGenKey').textContent = j2.sessionKey;
          document.getElementById('userGenAddr').textContent = j2.address;
          document.getElementById('userKeyGenResult').style.display = '';
          loadUserWallet();
        } catch (e) { alert('Generation failed: ' + (e.message || e)); }
        finally { btn.disabled = false; btn.textContent = 'Regenerate key'; }
      }
      loadUserWallet();
      async function saveAlchemy() {
        const v = document.getElementById('alchemyKey').value.trim();
        if (!v) return;
        await fetch('/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ALCHEMY_API_KEY: v }) });
        location.reload();
      }
      async function saveMmKey() {
        const v = document.getElementById('mmPk').value.trim();
        if (!v) return;
        await fetch('/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ MM_PRIVATE_KEY: v }) });
        location.reload();
      }
      async function saveOpenAi() {
        const key = document.getElementById('openAiKey').value.trim();
        const model = document.getElementById('openAiModel').value.trim();
        const updates = {};
        if (key) updates.OPENAI_API_KEY = key;
        if (model) updates.OPENAI_MODEL = model;
        await fetch('/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(updates) });
        location.reload();
      }
      async function saveCopilotMode() {
        const sel = document.getElementById('copilotMode');
        // Per-user mode: 'off' = autonomy, 'on' = co-pilot (legacy dropdown values kept for the UI)
        const mode = sel.value === 'on' ? 'copilot' : 'autonomy';
        if (mode === 'copilot' && !window.ethereum) { alert('Co-pilot needs a browser wallet (MetaMask/Rabby) installed before you can enable it.'); return; }
        const btns = document.querySelectorAll('#copilotMode ~ button, button[onclick^="saveCopilotMode"]');
        btns.forEach(function(b){ b.disabled = true; });
        try {
          const r = await fetch('/api/user/signer-mode', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mode }) });
          const j = await r.json();
          if (!j.ok) { alert(j.error); return; }
          location.reload();
        } catch (e) { alert(e.message); }
      }
      async function saveIndexerKeys() {
        const uni = document.getElementById('uniswapApiKey').value.trim();
        const graph = document.getElementById('theGraphKey').value.trim();
        const updates = {};
        if (uni) updates.UNISWAP_API_KEY = uni;
        if (graph) updates.THEGRAPH_API_KEY = graph;
        if (!Object.keys(updates).length) return;
        await fetch('/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(updates) });
        location.reload();
      }
      async function createVault() {
        const name = document.getElementById('vName').value, email = document.getElementById('vEmail').value, password = document.getElementById('vPassword').value;
        const r = await fetch('/api/vault/create', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, email, password }) });
        const j = await r.json();
        alert(j.ok ? 'Check your email for the verification code.' : j.error);
      }
      async function verifyVault() {
        const code = document.getElementById('vCode').value;
        const r = await fetch('/api/vault/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code }) });
        const j = await r.json();
        if (!j.ok) { alert(j.error); return; }
        location.reload();
      }
      async function importVault() {
        const content = document.getElementById('vFileContent').value, password = document.getElementById('vImportPassword').value;
        const r = await fetch('/api/vault/import', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ content, password }) });
        const j = await r.json();
        if (!j.ok) { alert(j.error); return; }
        location.reload();
      }
    </script>
  `, "settings");
}

// ── Alpha tab (self-hosted discovery engine, ported from COPY) ───────────────
// alpha-engine.mjs runs inside this process: DexScreener discovery + on-chain
// PONS launch/trade scanning + heuristic scoring. Read-only: nothing trades.
import { startAlphaEngine, getAlphaQueue, alphaEngine } from "./alpha-engine.mjs";
import { getCurveHolderDistribution } from "./alpha-holders.mjs";
startAlphaEngine().catch((e) => console.error("[alpha-engine] startup failed:", e.message));

let alphaCache = { at: 0, data: null, error: null };

async function fetchAlphaQueue() {
  if (alphaCache.data && Date.now() - alphaCache.at < 15000) return alphaCache;
  const snap = getAlphaQueue();
  alphaCache = { at: Date.now(), data: snap, error: snap.error };
  return alphaCache;
}

const alphaUsd = (v) => {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v), a = Math.abs(n);
  if (a >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
};
const alphaAge = (s) => {
  if (s == null || !Number.isFinite(Number(s))) return "—";
  s = Number(s);
  if (s < 60) return Math.max(1, Math.round(s)) + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
};

// Shared row renderer — used by the HTML page AND the /api/alpha/rows JSON
// endpoint so the two can never drift. Callers filter closed-source tokens out
// BEFORE rendering (security-failed tokens don't belong in the queue at all).
function alphaSecBadge(sec) {
  if (!sec || !sec.analyzed) return `<span class="pill off" title="GoPlus has not analyzed this token yet — unknown ≠ safe" style="font-size:0.7rem;padding:0.15rem 0.45rem">?</span>`;
  if (sec.honeypot) return `<span class="pill" title="honeypot/cannot-sell — DO NOT BUY" style="color:#f87171;border-color:rgba(248,113,113,0.4);font-size:0.7rem;padding:0.15rem 0.45rem">✗ trap</span>`;
  const tax = sec.sellTax != null ? Math.round(Number(sec.sellTax) * 100) : null;
  const warn = (sec.mintable || (tax != null && tax > 10)) ? " ⚠" : "";
  return `<span class="pill on" title="open source ✓, no honeypot flag${tax != null ? `, sell tax ${tax}%` : ""}${sec.mintable ? ", mintable ⚠" : ""}${sec.holders != null ? `, ${sec.holders} holders` : ""}" style="font-size:0.7rem;padding:0.15rem 0.45rem">✓${warn}</span>`;
}
function alphaRowsHtml(items) {
  return items.map((t) => {
    const addr = String(t.address || t.token || "");
    const score = Number(t.score || 0);
    const liq = Number(t.liquidity || 0);            // 0 on curves (no LP)
    const mcap = Number(t.marketCap || 0);
    const priceImd = Number(t.priceImd || 0);
    const sold = Number(t.soldPct || 0);
    const vol1h = Number(t.volume1hEth || 0);
    const vol24 = Number(t.volume24hEth || t.volume24h || 0);
    const buyers = t.uniqueBuyers;
    const scoreColor = score >= 85 ? "#4ade80" : score >= 70 ? "#e8b661" : "rgba(255,255,255,0.45)";
    const fmtImd = (p) => !p ? "—" : p < 0.0001 ? p.toExponential(2) : p.toFixed(6);
    // Compact USD price: subscript-zero notation for tiny prices ($0.0₄2729 = 0.00002729),
    // like Dexscreener. Keeps significant digits without the zero-run.
    const SUBS = ["₀","₁","₂","₃","₄","₅","₆","₇","₈","₉"];
    const sub = (n) => String(n).split("").map(c => SUBS[Number(c)] ?? c).join("");
    const fmtPriceUsd = (p) => {
      if (!p) return "—";
      if (p >= 1) return "$" + p.toFixed(2);
      if (p >= 0.01) return "$" + p.toFixed(4);
      // count leading zeros after "0."
      const s = p.toFixed(12);
      const m = s.match(/^0\.(0+)([1-9]\d*)/);
      if (!m) return "$" + p.toPrecision(4);
      const zeros = m[1].length;
      const sig = m[2].slice(0, 4).replace(/0+$/, "");
      return "$0.0" + sub(zeros) + sig;
    };
    const priceUsd = priceImd * imdUsd;              // IMD-denominated → USD
    const fmtEth = (v) => !v ? "—" : v >= 1 ? v.toFixed(2) : v.toFixed(3);
    // volume cells render in USD — ETH amounts × the live IMD price
    // (imdUsd comes from the ETH/IMD pool via Dexscreener, refreshed every 60s)
    const fmtEthUsd = (eth) => {
      const v = Number(eth || 0) * imdUsd;
      if (!v) return "—";
      if (v >= 1000) return "$" + (v / 1000).toFixed(1) + "K";
      if (v >= 1) return "$" + v.toFixed(2);
      return "$" + v.toFixed(3);
    };
    const fmtUsd = (v) => !v ? "—" : v >= 1000 ? "$" + (v/1000).toFixed(1) + "K" : "$" + v.toFixed(0);
    return `
    <tr data-score="${score}" data-liq="${liq}" data-kind="launch" data-search="${esc((String(t.symbol ?? "") + " " + String(t.name ?? "") + " " + addr).toLowerCase())}"
        data-sort-symbol="${esc(String(t.symbol ?? "").toLowerCase())}"
        data-sort-price="${priceUsd || 0}"
        data-sort-mcap="${mcap || 0}"
        data-sort-txns="${Number(t.buys || 0) + Number(t.sells || 0)}"
        data-sort-buyers="${buyers == null ? -1 : buyers}"
        data-sort-vol24="${vol24 || 0}"
        data-sort-vol1h="${vol1h || 0}"
        data-sort-age="${Number(t.ageSec || 0)}">
      <td><b style="color:${scoreColor};font-variant-numeric:tabular-nums">${score}</b></td>
      <td><button type="button" class="alpha-token-link" data-addr="${esc(addr)}" data-symbol="${esc(String(t.symbol ?? "?"))}" title="Holder distribution + token detail"><span style="font-weight:600">${esc(t.symbol ?? "?")}</span></button>${String(t.name ?? "").length > 10 ? `<br><span class="hint" title="${esc(t.name)}">${esc(String(t.name ?? "").slice(0, 10))}${String(t.name ?? "").length > 10 ? "…" : ""}</span>` : ""}</td>
      <td style="position:relative;overflow:hidden" title="IMD bonding-curve launch — ${sold.toFixed(1)}% sold">
        <div aria-hidden="true" style="position:absolute;inset:0;background:linear-gradient(90deg, rgba(74,222,128,${Math.min(0.32, 0.05 + sold/100*0.32).toFixed(3)}) ${sold.toFixed(1)}%, transparent ${sold.toFixed(1)}%);"></div>
        <span class="pill on" style="position:relative;color:#4ade80;font-size:0.62rem;padding:0.12rem 0.4rem;white-space:nowrap">CURVE<span style="opacity:0.9;margin-left:0.3rem;font-variant-numeric:tabular-nums">${sold.toFixed(1)}%</span></span>
      </td>
      <td style="font-variant-numeric:tabular-nums" title="${priceUsd ? "$" + priceUsd.toFixed(12).replace(/0+$/, "") : "—"}${priceImd ? ` · ${fmtImd(priceImd)} IMD` : ""}">${fmtPriceUsd(priceUsd)}${priceImd ? `<span class="hint"> · ${fmtImd(priceImd)} IMD</span>` : ""}</td>
      <td style="font-variant-numeric:tabular-nums">${mcap ? alphaUsd(mcap) : "—"}</td>
      <td class="center" style="font-variant-numeric:tabular-nums">${Number(t.buys || 0)}/${Number(t.sells || 0)}</td>
      <td class="center" style="font-variant-numeric:tabular-nums" title="unique curve buyers, 24h">${buyers == null ? "—" : buyers}</td>
      <td style="font-variant-numeric:tabular-nums" title="24h volume, USD (ETH × IMD price)">${fmtEthUsd(vol24)}</td>
      <td style="font-variant-numeric:tabular-nums" title="1h volume, USD (ETH × IMD price)">${fmtEthUsd(t.volume1hEth)}</td>
      <td>${alphaAge(t.ageSec)}</td>
      <td>${addr ? `<button type="button" class="icon-btn copy-addr" data-addr="${esc(addr)}" title="${esc(addr)} — click to copy" onclick="copyAddr(this)"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>` : `<span class="hint">—</span>`}</td>
      <td>
        ${addr ? `<a class="secondary" style="text-decoration:none;padding:0.3rem 0.7rem" href="/sniper?token=${esc(addr)}">Snipe</a>` : ""}
        ${t.url ? `<a class="icon-btn" href="${esc(t.url)}" target="_blank" rel="noreferrer noopener" title="Open on the launchpad"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1.5 12.5L5.5 8L8.5 10.5L14.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 3.5H14.5V7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ""}
      </td>
    </tr>`;
  }).join("");
}

/** Hide security-failed tokens from the queue entirely (closed source = OPAI lesson). */
function alphaVisible(items) {
  return items.filter((t) => !(t.security?.analyzed && (t.security.openSource === false || t.security.honeypot)));
}

async function alphaPage(srcParam = "on-curve", volParam = "0") {
  const { data, error } = await fetchAlphaQueue();
  // IMD launchpad: every coin is a bonding-curve launch (no graduation, no LP).
  // "on-curve" = everything on the indexer; "all" keeps the door open for
  // secondary-pool rows (Dexscreener detection — TODO, engine flags hasSecondaryPool).
  const src = srcParam === "all" ? "all" : "on-curve";
  const minVol = Math.max(0, Number(volParam) || 0);
  let items = (data?.items ?? []).slice().sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  if (src === "on-curve") items = items.filter((t) => t.kind === "launch" && !t.hasSecondaryPool);
  items = alphaVisible(items.filter((t) => Number(t.volume24h || 0) * (imdUsd || 0) >= minVol));
  const stale = error && data ? " (showing last good data)" : "";

  const rows = alphaRowsHtml(items);
  const pf = data?.platform;

  return shell("Alpha", `
    <h1>Alpha Queue <span class="hint" style="font-weight:400;font-size:0.85rem">· IMD launchpad indexer · <span id="alphaUpdated">updated —</span></span></h1>
    <div style="display:flex;gap:1.5rem;align-items:flex-start">
      <p class="hint" style="margin-top:-0.5rem;flex:1">IMD Community Coins — every coin is a permissionless bonding-curve launch priced in IMD. Identify by address ONLY (symbol squatters everywhere, incl. fake "IMD" coins). Sec = GoPlus. Scores are heuristics — everything is UNVERIFIED until a sell probe passes. Refreshes in place every 10s.
      ${pf ? `<br>Board: ${pf.coins} coins · ${Number(pf.volumeEth).toFixed(0)} ETH lifetime volume · ${Number(pf.imdBurned).toFixed(0)} IMD burned · ${Number(pf.creatorFeesEth).toFixed(2)} ETH creator fees` : ""}</p>
      <input id="alphaSearch" type="search" placeholder="Search symbol / name / 0x address…" autocomplete="off" spellcheck="false"
        style="flex:0 0 300px;max-width:340px;margin-top:-0.25rem;padding:0.45rem 0.7rem;font-size:0.85rem;background:#0d1015;color:#fff;border:1px solid rgba(255,255,255,0.18);border-radius:6px;outline:none">
    </div>
    ${error ? `<div class="card" style="border-color:rgba(248,113,113,0.4)"><b style="color:#f87171">Discovery feed degraded${stale}</b><p class="hint" style="margin:0.3rem 0 0">${esc(error)}</p></div>` : ""}
    <div class="card" style="display:flex;gap:1rem;align-items:center;margin-bottom:1rem">
      <span class="hint"><span id="alphaCount">${items.length} tokens</span></span>
      <span class="hint" style="margin-left:auto">Source
        <span id="srcFilter" class="seg-group" style="margin-left:0.4rem">
          <button type="button" class="seg-btn${src === "on-curve" ? " active" : ""}" data-src="on-curve" title="Every coin on the IMD bonding curves">On curve</button>
          <button type="button" class="seg-btn${src === "all" ? " active" : ""}" data-src="all" title="Everything, incl. coins with secondary pools (provenance unverified)">All</button>
        </span>
      </span>
      <span class="hint">Min 24h vol
        <span id="volFilter" class="seg-group" style="margin-left:0.4rem">
          ${[[0, "any"], [1, "$1+"], [10, "$10+"], [100, "$100+"]].map(([v, label]) =>
            `<button type="button" class="seg-btn${v === minVol ? " active" : ""}" data-vol="${v}">${label}</button>`).join("")}
        </span>
      </span>
      <span class="hint">Min score
        <span id="minScore" class="seg-group" style="margin-left:0.4rem">
          ${[[0, "any"], [60, "60"], [70, "70"], [80, "80"], [90, "90"]].map(([v, label]) =>
            `<button type="button" class="seg-btn${v === 0 ? " active" : ""}" data-value="${v}">${label}</button>`).join("")}
        </span>
      </span>
      <span class="hint">Min liquidity
        <span id="minLiq" class="seg-group" style="margin-left:0.4rem">
          ${[[0, "any"], [10000, "$10K"], [25000, "$25K"], [50000, "$50K"]].map(([v, label]) =>
            `<button type="button" class="seg-btn${v === 0 ? " active" : ""}" data-value="${v}">${label}</button>`).join("")}
        </span>
      </span>
    </div>
    <style>
      .seg-group { display:inline-flex; vertical-align:middle; }
      .seg-btn {
        background:#0d1015; color:rgba(255,255,255,0.55); border:1px solid rgba(255,255,255,0.15);
        padding:0.25rem 0.6rem; font-size:0.8rem; cursor:pointer; margin-left:-1px;
      }
      .seg-btn:first-child { border-radius:4px 0 0 4px; margin-left:0; }
      .seg-btn:last-child { border-radius:0 4px 4px 0; }
      .seg-btn:hover { color:#fff; }
      .seg-btn.active { background:rgba(232,182,97,0.15); color:#e8b661; border-color:rgba(232,182,97,0.5); z-index:1; position:relative; }
      .icon-btn {
        display:inline-flex; align-items:center; justify-content:center;
        width:26px; height:26px; padding:0; margin-left:0.25rem;
        background:none; border:none; border-radius:4px; cursor:pointer;
        color:rgba(255,255,255,0.45); vertical-align:middle;
      }
      .icon-btn:hover { color:rgba(255,255,255,0.85); background:rgba(255,255,255,0.06); }
      .icon-btn svg { display:block; }
      th.sortable { cursor:pointer; user-select:none; white-space:nowrap; }
      th.sortable:hover { color:#e8eaed; }
      th.sortable::after { content:"↕"; opacity:0.35; margin-left:0.3rem; font-size:0.72rem; }
      th.sortable.asc::after { content:"↑"; opacity:1; color:#e8b661; }
      th.sortable.desc::after { content:"↓"; opacity:1; color:#e8b661; }
      th.sortable.asc::before, th.sortable.desc::before { content:""; }
      th.center, td.center { text-align:center !important; }
    </style>
    <table>
      <thead><tr>
        <th class="sortable" data-key="score">Score</th>
        <th class="sortable" data-key="symbol">Token</th>
        <th>Curve</th>
        <th class="sortable" data-key="price">Price</th>
        <th class="sortable" data-key="mcap">MCap</th>
        <th class="sortable center" data-key="txns">Buy/Sell</th>
        <th class="sortable center" data-key="buyers">Buyers 24h</th>
        <th class="sortable" data-key="vol24">24h Vol</th>
        <th class="sortable" data-key="vol1h">1h Vol</th>
        <th class="sortable" data-key="age">Age</th>
        <th>CA</th><th></th>
      </tr></thead>
      <tbody id="alphaRows">${rows || `<tr><td colspan="12" class="hint">No tokens match — try widening the filters.</td></tr>`}</tbody>
    </table>
    <script>
      const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      function copyAddr(btn) {
        const swapCheck = () => {
          if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
          btn.innerHTML = CHECK_SVG;
          btn.style.color = "#4ade80";
          clearTimeout(btn._t);
          btn._t = setTimeout(() => { btn.innerHTML = btn.dataset.origHtml; btn.style.color = ""; }, 1200);
        };
        const done = () => { swapCheck(); };
        navigator.clipboard.writeText(btn.dataset.addr).then(done).catch(() => {
          // clipboard API can be blocked on http:// origins — fall back to a transient textarea
          const ta = document.createElement("textarea");
          ta.value = btn.dataset.addr;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); done(); } catch {}
          ta.remove();
        });
      }
      // ── Column sorting ────────────────────────────────────────────────
      // Click a header: sort by that column, toggling asc/desc (score
      // defaults desc, symbol asc). Sort state survives the 10s row swap —
      // pollAlpha calls resortRows() after each refresh.
      let sortKey = null, sortDir = null;
      const SORT_NUMERIC = new Set(["score","price","mcap","txns","buyers","vol24","vol1h","age"]);
      function resortRows() {
        const tbody = document.getElementById("alphaRows");
        if (!tbody || !sortKey) return;
        const rows = [...tbody.querySelectorAll("tr[data-sort-" + sortKey + "]")];
        const dir = sortDir === "asc" ? 1 : -1;
        rows.sort((a, b) => {
          const av = a.dataset["sort" + sortKey[0].toUpperCase() + sortKey.slice(1)];
          const bv = b.dataset["sort" + sortKey[0].toUpperCase() + sortKey.slice(1)];
          if (SORT_NUMERIC.has(sortKey)) return (Number(av) - Number(bv)) * dir;
          return String(av).localeCompare(String(bv)) * dir;
        });
        rows.forEach(r => tbody.appendChild(r));
        document.querySelectorAll("th.sortable").forEach(th => {
          th.classList.toggle("asc", th.dataset.key === sortKey && sortDir === "asc");
          th.classList.toggle("desc", th.dataset.key === sortKey && sortDir === "desc");
        });
      }
      document.querySelectorAll("th.sortable").forEach(th => {
        th.addEventListener("click", () => {
          const key = th.dataset.key;
          if (sortKey === key) { sortDir = sortDir === "asc" ? "desc" : "asc"; }
          else { sortKey = key; sortDir = (key === "symbol") ? "asc" : "desc"; }
          resortRows();
        });
      });
      function applyFilters() {
        const ms = Number(document.getElementById("minScore").querySelector(".seg-btn.active").dataset.value),
              ml = Number(document.getElementById("minLiq").querySelector(".seg-btn.active").dataset.value),
              q = (document.getElementById("alphaSearch")?.value || "").trim().toLowerCase();
        document.querySelectorAll("#alphaRows tr[data-score]").forEach(tr => {
          const matchesSearch = !q || (tr.dataset.search || "").includes(q);
          tr.style.display = (Number(tr.dataset.score) >= ms && Number(tr.dataset.liq) >= ml && matchesSearch) ? "" : "none";
        });
      }
      // Search: live, client-side, over symbol + name + contract address.
      // Applied on input AND re-applied after each 10s row swap (pollAlpha → applyFilters).
      const searchInput = document.getElementById("alphaSearch");
      let searchTimer = null;
      searchInput.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(applyFilters, 120);   // debounce fast typing
      });
      // "/" focuses the search box from anywhere on the page
      document.addEventListener("keydown", (e) => {
        if (e.key === "/" && document.activeElement !== searchInput) { e.preventDefault(); searchInput.focus(); }
      });
      document.querySelectorAll("#minScore, #minLiq").forEach(group => {
        group.querySelectorAll(".seg-btn").forEach(btn => {
          btn.onclick = () => {
            group.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            applyFilters();
          };
        });
      });
      // Live table refresh: poll the rows endpoint and swap the tbody in place.
      // Re-applies the active filters after each swap; no full-page reload.
      function activeFilters() {
        const src = document.getElementById("srcFilter")?.querySelector(".seg-btn.active")?.dataset.src ?? "on-curve";
        const vol = document.getElementById("volFilter")?.querySelector(".seg-btn.active")?.dataset.vol ?? "10000";
        return "src=" + src + "&vol=" + vol;
      }
      async function pollAlpha() {
        try {
          const r = await fetch("/api/alpha/rows?" + activeFilters());
          const j = await r.json();
          if (!j.ok) return;
          document.getElementById("alphaRows").innerHTML = j.rows || '<tr><td colspan="12" class="hint">No tokens match — try widening the filters.</td></tr>';
          const countEl = document.getElementById("alphaCount");
          if (countEl) countEl.textContent = j.count + " tokens";
          const updEl = document.getElementById("alphaUpdated");
          if (updEl && j.updatedAt) updEl.textContent = "updated " + Math.max(0, Math.round((Date.now() - new Date(j.updatedAt).getTime()) / 1000)) + "s ago";
          applyFilters();
          resortRows();
        } catch { /* transient — retry on next tick */ }
      }
      setInterval(pollAlpha, 10000);
      // Source + volume toggles: re-render from the server with the chosen
      // filters (also re-syncs the URL so a refresh keeps the selection).
      document.querySelectorAll("#srcFilter .seg-btn").forEach((btn) => {
        btn.onclick = () => {
          if (btn.classList.contains("active")) return;
          const vol = document.getElementById("volFilter")?.querySelector(".seg-btn.active")?.dataset.vol ?? "10000";
          location.href = "/alpha?src=" + btn.dataset.src + "&vol=" + vol;
        };
      });
      document.querySelectorAll("#volFilter .seg-btn").forEach((btn) => {
        btn.onclick = () => {
          document.querySelectorAll("#volFilter .seg-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          pollAlpha();
        };
      });
      // "updated Xs ago" ticker between polls
      setInterval(() => {
        const updEl = document.getElementById("alphaUpdated");
        if (!updEl) return;
        const m = updEl.textContent.match(/updated (\\d+)s ago/);
        if (m) updEl.textContent = "updated " + (Number(m[1]) + 1) + "s ago";
      }, 1000);

      // ── Token detail modal: donut holder distribution ─────────────────
      // Data provenance is shown verbatim in the modal (CLAUDE.md honesty
      // rule): distribution is DERIVED from curve trades, not an on-chain
      // holder snapshot.
      const fmtPct = (p) => (p >= 10 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(3)) + "%";
      const fmtAddr = (a) => a ? a.slice(0, 6) + "…" + a.slice(-4) : "—";
      const fmtImd = (v) => v == null ? "—" : v >= 1000 ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }) : v > 0 && v < 0.01 ? Number(v).toExponential(2) : Number(v).toFixed(2);
      const DONUT_COLORS = ["#e8b661","#4ade80","#60a5fa","#f472b6","#facc15","#a78bfa","#34d399","#fb923c","#38bdf8","#e879f9","#a3e635","#f87171"];
      // Client-side esc — the server's esc() isn't in scope inside the browser.
      const hesc = (s) => String(s ?? "").replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[ch]));
      let modalData = null;
      const TOP_SLICES = 12; // donut slices before "others"
      function donutSlices(holders) {
        const top = holders.slice(0, TOP_SLICES);
        const rest = holders.slice(TOP_SLICES).reduce((s, h) => s + h.pct, 0);
        return rest > 0.0001 ? [...top, { address: null, pct: rest, others: true }] : top;
      }
      function renderDonut(holders, userAddr) {
        const svg = document.getElementById("holderDonut");
        const legend = document.getElementById("donutLegend");
        const slices = donutSlices(holders);
        const R = 70, CX = 90, CY = 90, SW = 26;
        const C = 2 * Math.PI * R;
        let off = 0;
        const arcs = slices.map((s, i) => {
          const frac = Math.max(0, s.pct) / 100;
          const len = frac * C;
          const col = s.others ? "rgba(255,255,255,0.18)" : DONUT_COLORS[i % DONUT_COLORS.length];
          const label = s.others ? "Others (" + (holders.length - TOP_SLICES) + " wallets)" : (s.address === userAddr ? "YOU — " + fmtPct(s.pct) : fmtAddr(s.address) + " — " + fmtPct(s.pct));
          const el = '<circle cx="' + CX + '" cy="' + CY + '" r="' + R + '" fill="none" stroke="' + col + '" stroke-width="' + (s.address === userAddr ? SW + 3 : SW) + '" stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-off) + '" transform="rotate(-90 ' + CX + ' ' + CY + ')"' + (s.address ? ' data-addr="' + s.address + '" style="cursor:pointer"' : '') + '><title>' + (s.others ? "others" : s.address) + ' · ' + fmtPct(s.pct) + '</title></circle>';
          off += len;
          return { el, s, col, label };
        });
        svg.innerHTML = arcs.map((a) => a.el).join("") +
          '<text x="' + CX + '" y="' + (CY - 4) + '" text-anchor="middle" fill="#e8eaed" font-size="15" font-weight="600">' + holders.length + '</text>' +
          '<text x="' + CX + '" y="' + (CY + 12) + '" text-anchor="middle" fill="rgba(255,255,255,0.45)" font-size="8.5" letter-spacing="0.08em">HOLDERS</text>';
        legend.innerHTML = arcs.map((a, i) =>
          '<div class="legend-row" data-idx="' + i + '"' + (a.s.address === userAddr ? ' style="border-color:rgba(74,222,128,0.5)"' : '') + '>' +
          '<span class="swatch" style="background:' + a.col + '"></span>' +
          '<span class="legend-label">' + a.label + '</span>' +
          '<span class="legend-pct">' + fmtPct(a.s.pct) + '</span></div>').join("");
      }
      function pickHolder(addr) {
        document.querySelectorAll(".legend-row").forEach((r) => r.classList.remove("picked"));
        const me = (modalData?.holders ?? []).find((h) => h.address === addr);
        const info = document.getElementById("holderInfo");
        if (!me) { info.textContent = ""; return; }
        const creatorTag = me.isCreator ? ' <span class="pill on" style="font-size:0.62rem;padding:0.1rem 0.4rem">creator</span>' : "";
        const youTag = modalData.user && me.address === modalData.user.address ? ' <span class="pill on" style="font-size:0.62rem;padding:0.1rem 0.4rem">you</span>' : "";
        const avg = me.imdSpent > 0 ? " · avg entry " + fmtImd(me.imdSpent / me.amount) + " IMD" : "";
        info.innerHTML = '<b>' + fmtAddr(me.address) + '</b>' + creatorTag + youTag + ' — ' + fmtPct(me.pct) + ' · ' + fmtImd(me.amount) + ' coins' + avg;
        const idx = donutSlices(modalData.holders).findIndex((s) => s.address === addr);
        const row = document.querySelector('.legend-row[data-idx="' + idx_maybe(idx) + '"]');
        if (row) row.classList.add("picked");
      }
      // Clicks on donut arcs: the <dialog> is declared after this script, so
      // delegate off document (also survives the dialog being re-created).
      // A script-local fn is fine here — the closure keeps pickHolder alive.
      document.addEventListener("click", (e) => {
        if (e.target.tagName === "circle" && e.target.getAttribute("data-addr")) pickHolder(e.target.getAttribute("data-addr"));
      });
      function idx_maybe(i) { return i >= 0 ? i : -1; }
      function creatorPhrase(c, j) {
        const h = (j.holders ?? []).find((x) => x.isCreator);
        return h ? " holds " + fmtPct(h.pct) + " (" + fmtImd(h.amount) + " coins)." : " is not currently holding.";
      }
      async function openTokenModal(btn) {
        const modal = document.getElementById("tokenModal");
        const body = document.getElementById("tokenModalBody");
        modal.showModal();
        body.innerHTML = '<div class="hint">loading…</div>';
        try {
          const r = await fetch("/api/alpha/holders?address=" + encodeURIComponent(btn.dataset.addr));
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || "fetch failed");
          modalData = j;
          const c = j.coin;
          const age = c.createdAt ? Math.max(1, Math.round((Date.now() - c.createdAt) / 1000)) : null;
          const ageStr = !age ? "—" : age < 3600 ? Math.round(age / 60) + "m" : age < 86400 ? Math.round(age / 3600) + "h" : Math.round(age / 86400) + "d";
          const userCard = j.user ? (
            j.user.amount > 0
              ? '<div class="user-pos"><b style="color:#4ade80">Your position</b> — ' + fmtPct(j.user.pct) + ' of holders' + (j.user.rank ? " · rank #" + j.user.rank : "") + ' · ' + fmtImd(j.user.amount) + ' coins' + (j.user.avgEntryImd ? ' · avg entry ' + fmtImd(j.user.avgEntryImd) + ' IMD' : '') + '</div>'
              : '<div class="user-pos" style="color:rgba(255,255,255,0.4)">You hold none of this token (on-curve).</div>'
          ) : "";
          body.innerHTML =
            '<div class="tm-head"><span class="tm-symbol">' + hesc(c.symbol) + '</span>' +
            '<span class="hint">' + hesc(c.name || "") + '</span>' +
            '<button type="button" class="icon-btn" title="Copy contract address" onclick="copyAddrEl(this)" data-addr="' + c.address + '"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>' +
            (c.address ? '<a class="secondary" style="text-decoration:none;padding:0.25rem 0.6rem;font-size:0.78rem;margin-left:auto" href="/sniper?token=' + c.address + '">Snipe</a>' : '') + '</div>' +
            '<div class="tm-meta hint">age ' + ageStr + ' · ' + c.tradeCount.toLocaleString() + ' trades (' + c.buyCount + '/' + c.sellCount + ' buy/sell) · ' + fmtImd(c.volumeImd) + ' IMD volume' + (j.complete ? "" : ' · <b style="color:#e8b661">last ' + j.tradesAnalyzed.toLocaleString() + ' of ' + c.tradeCount.toLocaleString() + ' trades only — positions incomplete</b>') + '</div>' +
            userCard +
            '<div class="donut-wrap"><svg id="holderDonut" viewBox="0 0 180 180" width="180" height="180"></svg><div id="donutLegend" class="donut-legend"></div></div>' +
            '<div id="holderInfo" class="hint" style="min-height:1.2rem"></div>' +
            '<p class="hint" style="border-top:1px solid rgba(255,255,255,0.09);padding-top:0.6rem;margin-top:0.8rem">Derived from ' + j.tradesAnalyzed.toLocaleString() + ' curve trades across ' + j.walletsTraded.toLocaleString() + ' wallets (launchpad indexer' + (j.tradesSkipped ? ', ' + j.tradesSkipped.toLocaleString() + ' earliest trades skipped' : '') + '). Net buys − sells per wallet — not an on-chain balance scan. Creator ' + '<span class="mono">' + fmtAddr(c.creator) + '</span>' + creatorPhrase(c, j) + '</p>';
          renderDonut(j.holders, j.user?.address ?? null);
        } catch (e) {
          body.innerHTML = '<p style="color:#f87171">Failed to load: ' + hesc(e.message || e) + '</p>';
        }
      }
      function copyAddrEl(btn) { btn.dataset.addr; navigator.clipboard?.writeText(btn.dataset.addr).catch(() => {}); }
      // Delegated: rows are re-rendered every 10s by pollAlpha, so bind on document
      document.addEventListener("click", (e) => {
        const btn = e.target.closest(".alpha-token-link");
        if (btn) { e.preventDefault(); openTokenModal(btn); }
      });
    </script>
    <dialog id="tokenModal" style="width:min(560px, calc(100% - 2rem))">
      <div id="tokenModalBody"></div>
      <button class="secondary" type="button" onclick="document.getElementById('tokenModal').close()">Close</button>
    </dialog>
    <style>
      .alpha-token-link { background:none; border:none; padding:0; color:inherit; cursor:pointer; font:inherit; text-align:left; }
      .alpha-token-link:hover span { color:#e8b661; text-decoration:underline; }
      .tm-head { display:flex; align-items:center; gap:0.6rem; margin-bottom:0.3rem; }
      .tm-symbol { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-weight:700; font-size:1.05rem; color:#e8b661; letter-spacing:0.04em; }
      .tm-meta { margin-bottom:0.7rem; }
      .user-pos { background:rgba(74,222,128,0.06); border:1px solid rgba(74,222,128,0.25); border-radius:4px; padding:0.5rem 0.7rem; margin-bottom:0.8rem; font-size:0.85rem; }
      .donut-wrap { display:flex; gap:1rem; align-items:flex-start; margin:0.4rem 0 0.5rem; }
      .donut-legend { flex:1; max-height:230px; overflow-y:auto; }
      .legend-row { display:flex; align-items:center; gap:0.5rem; padding:0.18rem 0.4rem; border:1px solid transparent; border-radius:3px; font-size:0.78rem; font-variant-numeric:tabular-nums; }
      .legend-row:hover, .legend-row.picked { background:rgba(255,255,255,0.05); }
      .legend-row .swatch { width:9px; height:9px; border-radius:50%; flex:none; }
      .legend-label { flex:1; color:rgba(255,255,255,0.75); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:0.72rem; }
      .legend-pct { color:#e8eaed; font-weight:600; }
      .mono { font-family:ui-monospace,"SF Mono",Menlo,monospace; }
    </style>
  `, "alpha");
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const url = requestUrl.pathname;
  const method = req.method ?? "GET";

  const send = (html) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); };
  // BigInt-safe: probes return bigint balance deltas, and a JSON.stringify
  // throw here happens AFTER writeHead — the outer catch then double-responds
  // (ERR_HTTP_HEADERS_SENT) and the unhandled rejection kills the process.
  const json = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))); };
  const redirect = (to) => { res.writeHead(302, { Location: to }); res.end(); };
  const readBody = () => new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); });

  try {
    // ── Wallet-signature auth gate ──────────────────────────────────────
    // SIWE-style: connect + sign a one-time nonce; HMAC cookie session.
    // Handles /api/auth/* itself; serves the login page or 401s APIs when
    // unauthenticated. Returns false to proceed with normal routing.
    if (await handleAuth(req, res, { url, method, readBody, json, send, shell })) return;

    if (url === "/" || url === "") return redirect("/overview");
    if (url === "/overview" && method === "GET") return send(await overviewPage(sessionAddress(req)));
    if (url === "/tokens" && method === "GET") return send(await watchersPage(undefined, requestUrl.searchParams.get("plan"), sessionAddress(req)));
    if (url.startsWith("/tokens/") && method === "GET") {
      const page = await tokenDetailPage(decodeURIComponent(url.split("/")[2]), sessionAddress(req));
      return page ? send(page) : redirect("/tokens");
    }
    if (url === "/alpha" && method === "GET") return send(await alphaPage(requestUrl.searchParams.get("src"), requestUrl.searchParams.get("vol")));
    // Lightweight polling endpoint: returns the queue's tbody rows + meta so
    // the page can update in place instead of a full 20s reload.
    // src: on-curve (default — every IMD curve coin) | all (+ secondary pools)
    // vol: min 24h volume in USD (default 10000 — dead graduates filtered out)
    const srcParam = requestUrl.searchParams.get("src") ?? "on-curve";
    const src = srcParam === "all" ? "all" : "on-curve";
    const minVol = Math.max(0, Number(requestUrl.searchParams.get("vol") ?? "0") || 0);
    if (url === "/api/alpha/rows" && method === "GET") {
      const { data, error } = await fetchAlphaQueue();
      let items = (data?.items ?? []).slice().sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
      if (src === "on-curve") items = items.filter((t) => t.kind === "launch" && !t.hasSecondaryPool);
      items = alphaVisible(items.filter((t) => Number(t.volume24h || 0) * (imdUsd || 0) >= minVol));
      return json({ ok: true, src, minVol, count: items.length, updatedAt: data?.updatedAt ?? null, status: data?.status ?? null, error: error ?? null, rows: alphaRowsHtml(items) });
    }
    if (await handleSniperRequest(url, method, { req, readBody, json, send, shell, esc, explorerLink, getChain, sessionAddress })) return;
    // Alpha token modal: full holder distribution for a curve coin. Read-only
    // (one indexer fetch, 5-min server cache) — no funds move, no approval needed.
    if (url === "/api/alpha/holders" && method === "GET") {
      try {
        const addr = requestUrl.searchParams.get("address") ?? "";
        let user = null;
        try {
          if (await isSignerConfigured()) user = (await resolveSigner("ethereum")).address;
        } catch { /* no wallet configured — modal just hides the position card */ }
        return json({ ok: true, ...(await getCurveHolderDistribution(addr, { userAddress: user })) });
      } catch (e) { return json({ ok: false, error: e.message }, 404); }
    }
    if (await handleMmRequest(url, method, { readBody, json, send, shell, esc, explorerLink, getChain })) return;
    if (await handleVerifyRequest(url, method, { readBody, json, send, shell, esc })) return;
    if (url === "/trades" && method === "GET") return send(tradesPage(sessionAddress(req)));
    if (url === "/settings" && method === "GET") return send(await settingsPage("", sessionAddress(req)));

    // ── Per-user trading wallet (session key / SCW) ────────────────────────
    if (url === "/api/user/wallet" && method === "GET") {
      try {
        const uid = sessionAddress(req);
        if (!uid) return json({ ok: false, error: "authentication required" }, 401);
        return json(await getUserWalletStatus(uid, "ethereum"));
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (url === "/api/user/session-key" && method === "POST") {
      try {
        const uid = sessionAddress(req);
        if (!uid) return json({ ok: false, error: "authentication required" }, 401);
        const body = JSON.parse(await readBody() || "{}");
        const r = await generateUserSessionKey(uid, "ethereum", { force: body.force === true });
        return json(r);
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    // Per-user signer mode toggle (autonomy requires a stored session key)
    if (url === "/api/user/signer-mode" && method === "POST") {
      try {
        const uid = sessionAddress(req);
        if (!uid) return json({ ok: false, error: "authentication required" }, 401);
        const { mode } = JSON.parse(await readBody());
        if (!["copilot", "autonomy"].includes(mode)) return json({ ok: false, error: "mode must be copilot or autonomy" });
        if (mode === "autonomy") {
          const { resolveUserSessionKeyAsync } = await import("./smart-wallet-api.mjs");
          if (!(await resolveUserSessionKeyAsync(uid))) {
            return json({ ok: false, error: "generate a session key first — autonomy needs one to sign trades" });
          }
        }
        setUserField(uid, "signer_mode", mode);
        return json({ ok: true, mode });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    // ── Co-pilot mode: SSE stream + approval endpoints ─────────────────────
    if (url === "/api/copilot/stream" && method === "GET") {
      const remove = addSseClient(res);
      req.on("close", remove);
      return; // SSE — response stays open; do NOT fall through to other handlers
    }
    if (url === "/api/copilot/pending" && method === "GET") {
      const uid = sessionAddress(req);
      const requests = uid ? listPending().filter((r) => !r.user_id || r.user_id === uid) : listPending();
      return json({ ok: true, active: isCopilotActive(), count: requests.length, requests });
    }
    if (url === "/api/copilot/history" && method === "GET") {
      return json({ ok: true, requests: listRecent(30) });
    }
    if (url === "/api/copilot/resolve" && method === "POST") {
      try {
        const { id, txHash } = JSON.parse(await readBody());
        if (!id || !txHash) return json({ ok: false, error: "id and txHash required" });
        const r = resolveRequest(id, txHash, sessionAddress(req));
        return json(r.ok ? r : { ...r }, r.ok ? 200 : 409);
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (url === "/api/copilot/decline" && method === "POST") {
      try {
        const { id, reason } = JSON.parse(await readBody());
        if (!id) return json({ ok: false, error: "id required" });
        const r = declineRequest(id, reason || "declined by user in browser", sessionAddress(req));
        return json(r, r.ok ? 200 : 409);
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    // Toggle: POST /api/copilot/mode { active: true|false }
    if (url === "/api/copilot/mode" && method === "POST") {
      try {
        const { active } = JSON.parse(await readBody());
        if (typeof active !== "boolean") return json({ ok: false, error: "active (boolean) required" });
        if (active) {
          if (!sessionAddress(req)) return json({ ok: false, error: "sign in with your wallet first — co-pilot signs with the browser wallet" });
        }
        writeEnvValues({ COPILOT_ACTIVE: active ? "true" : "false" });
        if (!active) {
          // Leaving co-pilot: expire any pending requests so blocked engines resume as skipped.
          for (const r of listPending()) declineRequest(r.id, "co-pilot mode switched off");
        }
        const { invalidateSigner } = await import("./signer.mjs");
        invalidateSigner();
        console.log(`[copilot] mode ${active ? "ENABLED — all trades now require browser approval" : "disabled"}`);
        return json({ ok: true, active });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (url === "/api/copilot/requests" && method === "GET") {
      // Admin/debug view incl. resolved rows
      const limit = Math.min(200, Number(requestUrl.searchParams.get("limit") ?? 30) || 30);
      return json({ ok: true, requests: listRecent(limit) });
    }

    if (url === "/settings" && method === "POST") {
      try { writeEnvValues(JSON.parse(await readBody())); return json({ ok: true }); }
      catch (e) { return json({ ok: false, error: e.message }); }
    }

    // Gas ledger: pull receipts for every historical tx hash in the trade
    // tables and record their gas spend. Idempotent — known hashes are
    // skipped, so it's safe to run repeatedly.
    if (url === "/api/gas/backfill" && method === "POST") {
      try {
        const result = await backfillGasFromChain();
        console.log(`[gas-ledger] backfill: ${result.recorded} recorded, ${result.missing} unavailable (of ${result.found})`);
        return json({ ok: true, recorded: result.recorded, missing: result.missing, found: result.found, totals: result.totals });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    // Gas breakdown modal data: per chain × product (Sniper/Accumulate/MM).
    if (url === "/api/gas/breakdown" && method === "GET") {
      try {
        const b = getGasBreakdown();
        return json({ ok: true, rows: b.rows, totals: b.totals });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    // Honeypot registry: flag a token as a trap by symbol (chain inferred from
    // the sniper ledger / watchers; ethLost optional override in ETH).
    if (url === "/api/honeypot/flag" && method === "POST") {
      try {
        const { symbol, ethLost = null, note = null } = JSON.parse(await readBody());
        if (!symbol || typeof symbol !== "string") return json({ ok: false, error: "symbol is required" });
        // Find the token's chain/address: prefer watchers, then the sniper ledger.
        const sym = symbol.toUpperCase();
        const w = getDipWatchers().find((x) => (x.symbol ?? "").toUpperCase() === sym);
        let chain, address;
        if (w) { chain = w.chain || "ethereum"; address = w.contract_address; }
        else {
          const t = getSniperTrades(500).find((x) => (x.symbol ?? "").toUpperCase() === sym);
          if (!t) return json({ ok: false, error: `no token "${symbol}" found in watchers or sniper trades` });
          chain = t.chain; address = t.contract_address;
        }
        addHoneypotToken({ chain, contractAddress: address, symbol: sym, ethLost, note, source: "manual" });
        return json({ ok: true, chain, address });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    if (url.startsWith("/api/honeypot/unflag/") && method === "POST") {
      try {
        const chain = decodeURIComponent(url.split("/")[3]);
        const address = decodeURIComponent(url.split("/")[4]);
        const changes = removeHoneypotToken(chain, address);
        return json({ ok: true, changes });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    if (url.startsWith("/api/icon/") && method === "GET") {
      const parts = url.split("/"); // /api/icon/:kind/:chainKey[/:address]
      const kind = parts[3], chainKey = parts[4];
      const address = kind === "token" ? decodeURIComponent(parts[5] ?? "") : undefined;
      const symbol = requestUrl.searchParams.get("s") ?? undefined;
      const icon = await getIcon(kind, chainKey, address, symbol);
      res.writeHead(200, {
        "Content-Type": icon.contentType,
        "Cache-Control": icon.contentType.includes("svg") ? "no-cache" : "public, max-age=604800, immutable",
      });
      return res.end(icon.data);
    }

    if (url === "/api/watchers" && method === "POST") {
      try {
        const { chain, contractAddress, poolAddress } = JSON.parse(await readBody());
        const chainKey = chain || "ethereum";
        if (!CHAIN_KEYS.includes(chainKey)) return json({ ok: false, error: `unsupported chain "${chainKey}" — expected one of ${CHAIN_KEYS.join(", ")}` });
        if (!contractAddress?.match(/^0x[0-9a-fA-F]{40}$/)) return json({ ok: false, error: "invalid contract address" });
        // Validate the pool override BEFORE persisting so a bad paste fails here
        if (poolAddress) {
          try { await resolvePoolOverride(contractAddress, poolAddress, chainKey); }
          catch (e) { return json({ ok: false, error: e.message }); }
        }
        const { symbol, decimals } = await getTokenMeta(contractAddress, chainKey);
        const id = randomUUID();
        // Tokens are added DORMANT (paused, zeroed dip settings): the add flow
        // takes only a contract address — a plan (manual Set plan)
        // arms it. Zeroed threshold/buy never reach the daemon because active=0.
        addDipWatcher({
          id, chain: chainKey, contractAddress, symbol, decimals,
          thresholdUsd: 0, buyAmountUsd: 0, slippagePct: 3, cooldownMinutes: 15,
          poolAddress: poolAddress || null,
          userId: sessionAddress(req),
        });
        setDipWatcherActive(id, 0);
        // Scan the wallet for any existing balance/cost basis in this token — don't
        // block the response on it, it can take a few seconds for active tokens.
        computeAndStorePosition({ id, contract_address: contractAddress, decimals, chain: chainKey }).catch(() => {});
        return json({ ok: true, symbol });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    if (url.startsWith("/api/watchers/") && url.endsWith("/strategy") && method === "POST") {
      try {
        const watcherId = decodeURIComponent(url.split("/")[3]);
        const ownershipError = watcherOwnershipError(req, watcherId);
        if (ownershipError) return json({ ok: false, error: ownershipError }, 403);
        const watcher = getDipWatcher(watcherId);
        if (!watcher) return json({ ok: false, error: "token not found" });
        const body = JSON.parse(await readBody());
        const totalBudgetUsd = Number(body.totalBudgetUsd);
        const cadenceDays = Number(body.cadenceDays);
        const baseBuyUsd = Number(body.baseBuyUsd);
        const dipThresholdUsd = Number(body.dipThresholdUsd);
        const dipBuyUsd = Number(body.dipBuyUsd);
        const slippagePct = Number(body.slippagePct ?? watcher.slippage_pct ?? 3);
        const cooldownMinutes = Number(body.cooldownMinutes ?? watcher.cooldown_minutes ?? 15);
        const periodDays = Number(body.periodDays ?? 30);
        if (!(totalBudgetUsd > 0)) return json({ ok: false, error: "total budget must be a positive number" });
        if (!(cadenceDays > 0) || cadenceDays > 365) return json({ ok: false, error: "cadence must be between >0 and 365 days" });
        if (!(baseBuyUsd > 0)) return json({ ok: false, error: "base buy must be a positive number" });
        if (!(dipThresholdUsd >= 0)) return json({ ok: false, error: "dip threshold must be >= 0" });
        if (!(dipBuyUsd > 0)) return json({ ok: false, error: "dip buy must be a positive number" });
        if (!(slippagePct >= 0.1 && slippagePct <= 15)) return json({ ok: false, error: "slippage must be 0.1–15%" });
        if (!(Number.isInteger(cooldownMinutes) && cooldownMinutes >= 1)) return json({ ok: false, error: "cooldown must be a whole number of minutes ≥ 1" });
        if (!(periodDays >= 1 && periodDays <= 365)) return json({ ok: false, error: "period must be 1–365 days" });

        const cadenceMinutes = Math.round(cadenceDays * 1440);
        const trancheCount = Math.max(1, Math.ceil(periodDays / cadenceDays));
        const scheduledAllocationUsd = round2(baseBuyUsd * trancheCount);
        const dipReserveUsd = round2(Math.max(0, totalBudgetUsd - scheduledAllocationUsd));
        if (scheduledAllocationUsd + dipReserveUsd > totalBudgetUsd + 0.001) {
          return json({ ok: false, error: `scheduled buys ($${scheduledAllocationUsd.toFixed(2)}) + dip reserve would exceed the budget` });
        }
        if (dipReserveUsd < dipBuyUsd) return json({ ok: false, error: `dip buy ($${dipBuyUsd.toFixed(2)}) exceeds the dip reserve ($${dipReserveUsd.toFixed(2)}) — raise the budget or lower the base buys` });
        const maxBuyUsd = Math.max(baseBuyUsd, dipBuyUsd);

        const proposal = {
          version: 2, plannedBy: "manual", profile: "manual",
          totalBudgetUsd, maxBuyUsd, periodDays,
          startAt: sqlNow(), endAt: sqlPlusDays(periodDays),
          cadenceMinutes, cadenceLabel: `${cadenceDays} day${cadenceDays === 1 ? "" : "s"}`,
          baseBuyUsd, scheduledTrancheCount: trancheCount, scheduledAllocationUsd,
          dipReserveUsd, dipBuyUsd, dipThresholdUsd, slippagePct, cooldownMinutes,
          warnings: [], methodology: "User-configured accumulation plan (manual entry in the token watcher UI).",
        };
        // Pool override (validated on-chain before persisting; empty/"auto" clears it)
        let resolvedPool = null;
        try { resolvedPool = await resolvePoolOverride(watcher.contract_address, body.poolAddress ?? "", watcher.chain || "ethereum"); }
        catch (e) { return json({ ok: false, error: e.message }); }
        const strategy = applyAccumulationStrategy({
          id: randomUUID(), reviewId: "manual", watcherId, proposal, replace: !!body.replace,
        });
        // Dip buys read slippage from the watcher row (not the strategy), so
        // keep both in sync when the plan sets it.
        updateDipWatcherSlippage(watcherId, slippagePct);
        setDipWatcherPool(watcherId, resolvedPool ? (resolvedPool.kind === "v4" ? resolvedPool.poolId : resolvedPool.address) : null);
        // Arming point: applying a plan activates the watcher so the daemon
        // starts executing it (scheduled + dip buys). Dormant tokens arm here.
        setDipWatcherActive(watcherId, 1);
        return json({ ok: true, strategy });
      } catch (error) {
        return json({ ok: false, error: error.message });
      }
    }

    if (url.startsWith("/api/watchers/") && url.endsWith("/exit") && method === "POST") {
      const id = decodeURIComponent(url.split("/")[3]);
      const watcher = getDipWatcher(id);
      if (!watcher) return json({ ok: false, error: "token not found" });
      let amt = NaN; // hoisted so the catch block can persist the error row
      try {
        if (!(await isSignerConfigured(sessionAddress(req)))) return json({ ok: false, error: "no wallet configured — set one in Settings" });
        const { amount, slippagePct } = JSON.parse(await readBody());
        amt = Number(amount);
        if (!(amt > 0)) return json({ ok: false, error: "amount must be a positive number" });
        const slippage = Number(slippagePct ?? watcher.slippage_pct ?? 3);
        const signer = await resolveSigner(watcher.chain || "ethereum");
        const result = await executeSniperSell({
          signer,
          chainKey: watcher.chain || "ethereum",
          tokenAddress: watcher.contract_address,
          amountHuman: amt,
          slippagePct: Number.isFinite(slippage) && slippage > 0 ? slippage : 3,
          pool: watcher.pool_address ?? null, // saved V4 poolId/V3 address beats Dexscreener (which rate-limits)
        });
        insertDipTrade({
          watcher_id: id, sell_tx_hash: result.txHash, sell_usd: null,
          buy_tx_hash: null, eth_spent: null, token_amount: -amt,
          price_usd: watcher.price_usd ?? null, status: "ok",
          execution_kind: "exit",
        });
        // Honeypot guard: an exit that returns nothing (or dust) is the
        // QUORUM signature — the swap "succeeds" but the wallet receives no
        // quote asset. Auto-pause watcher + strategy so scheduled buys stop
        // feeding it, and stamp an error row so the Trades page shows why.
        try {
          const gotEth = Number(result.ethReceived ?? 0);
          const soldEthWorth = Number(result.amountIn ?? 0);
          if (soldEthWorth > 0 && !(gotEth > 0)) {
            setDipWatcherActive(id, 0);
            setAccumulationStrategyActive(id, 0);
            insertDipTrade({
              watcher_id: id, sell_tx_hash: null, sell_usd: null,
              buy_tx_hash: null, eth_spent: null,
              token_amount: null, price_usd: null, status: "error",
              error: `HONEYPOT SUSPECTED: exit sold ${amt} tokens but no quote asset was delivered (tx ${result.txHash}). Watcher + strategy auto-paused.`,
              execution_kind: "exit",
            });
            console.error(`[exit] HONEYPOT GUARD: ${watcher.symbol ?? id} sold ${amt} tokens with $0 delivered — watcher + strategy paused`);
          }
        } catch (guardErr) { console.error("[exit] honeypot guard error:", guardErr.message); }
        computeAndStorePosition(watcher).catch(() => {});
        return json({ ok: true, txHash: result.txHash, dex: result.dex, label: result.label, amountIn: result.amountIn });
      } catch (e) {
        // Persist the failed exit so it shows on the Trades page with its
        // reason — silent failures here look like the app stalled (they did,
        // 2026-09-10: ATLANTIS exit stalled with nothing recorded anywhere).
        try {
          insertDipTrade({
            watcher_id: id, sell_tx_hash: null, sell_usd: null,
            buy_tx_hash: null, eth_spent: null,
            token_amount: Number.isFinite(amt) ? -amt : null,
            price_usd: watcher.price_usd ?? null, status: "error",
            error: e.message, execution_kind: "exit",
          });
        } catch (logErr) { console.error("[exit] failed to persist error row:", logErr.message); }
        return json({ ok: false, error: e.message });
      }
    }

    if (url.startsWith("/api/strategies/") && url.endsWith("/toggle") && method === "POST") {
      try {
        const watcherId = decodeURIComponent(url.split("/")[3]);
        const { active } = JSON.parse(await readBody());
        setAccumulationStrategyActive(watcherId, !!active);
        return json({ ok: true });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (url.startsWith("/api/watchers/") && url.endsWith("/toggle") && method === "POST") {
      const id = decodeURIComponent(url.split("/")[3]);
      const ownershipError = watcherOwnershipError(req, id);
      if (ownershipError) return json({ ok: false, error: ownershipError }, 403);
      try {
        const { active } = JSON.parse(await readBody());
        // Guard: a dormant token has no plan and zeroed dip settings — arming
        // it would make every sell qualify (threshold 0) and buy $0 clips.
        if (active && !getAccumulationStrategy(id)) {
          return json({ ok: false, error: "no plan set — click Set plan before resuming" });
        }
        setDipWatcherActive(id, !!active);
        return json({ ok: true });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    // Manual "Buy now": execute the token's active accumulation plan immediately
    // (scheduled buys fire on cadence via the daemon; this is the on-demand path).
    if (url.startsWith("/api/watchers/") && url.endsWith("/buy-now") && method === "POST") {
      const id = decodeURIComponent(url.split("/")[3]);
      const ownershipError = watcherOwnershipError(req, id);
      if (ownershipError) return json({ ok: false, error: ownershipError }, 403);
      const watcher = getDipWatcher(id);
      if (!watcher) return json({ ok: false, error: "token not found" });
      const strategy = getAccumulationStrategy(id);
      if (!strategy) return json({ ok: false, error: "no plan set — click Set plan first" });
      const amountUsd = Number(strategy.base_buy_usd);
      if (!(amountUsd > 0)) return json({ ok: false, error: "plan base buy is $0" });
      let reservation;
      try {
        reservation = reserveStrategyExecution({
          strategyId: strategy.id,
          watcherId: id,
          kind: "scheduled",
          amountUsd,
          scheduledFor: new Date().toISOString(),
          ignoreSchedule: true,   // manual "Buy now" overrides the cadence; budget/allocation guards still apply
        });
        const chainKey = watcher.chain || "ethereum";
        const signer = await resolveSigner(chainKey);
        const { txHash, quotedOut, eth_spent } = await buyToken(signer, watcher.contract_address, amountUsd, { slippagePct: strategy.slippage_pct ?? watcher.slippage_pct ?? 3, chainKey });
        const tokenAmount = Number(formatUnits(BigInt(quotedOut), watcher.decimals ?? 18));
        finalizeStrategyExecution({ executionId: reservation.executionId, txHash });
        insertDipTrade({
          watcher_id: id,
          buy_tx_hash: txHash,
          eth_spent: eth_spent ?? null,
          token_amount: tokenAmount,
          price_usd: tokenAmount > 0 ? amountUsd / tokenAmount : null,
          strategy_id: strategy.id,
          execution_kind: "scheduled",
        });
        return json({ ok: true, txHash, tokenAmount, symbol: watcher.symbol });
      } catch (e) {
        if (reservation) finalizeStrategyExecution({ executionId: reservation.executionId, error: e.message });
        insertDipTrade({
          watcher_id: id,
          strategy_id: strategy.id,
          execution_kind: "scheduled",
          status: "error",
          error: e.message,
        });
        return json({ ok: false, error: e.message });
      }
    }

    if (url.startsWith("/api/watchers/") && url.endsWith("/refresh-position") && method === "POST") {
      const id = decodeURIComponent(url.split("/")[3]);
      const watcher = getDipWatcher(id);
      if (!watcher) return json({ ok: false, error: "token not found" });
      await computeAndStorePosition(watcher);
      const updated = getDipWatcher(id);
      if (updated.position_error) return json({ ok: false, error: updated.position_error });
      return json({ ok: true, watcher: updated });
    }

    if (url.startsWith("/api/watchers/") && method === "PATCH") {
      try {
        const id = decodeURIComponent(url.replace("/api/watchers/", ""));
        const ownershipError = watcherOwnershipError(req, id);
        if (ownershipError) return json({ ok: false, error: ownershipError }, 403);
        const watcher = getDipWatcher(id);
        if (!watcher) return json({ ok: false, error: "token not found" });
        const strategy = getAccumulationStrategy(id);
        if (strategy?.active) return json({ ok: false, error: "pause the active plan before editing manual settings" });
        const { thresholdUsd, buyAmountUsd, slippagePct, cooldownMinutes, poolAddress } = JSON.parse(await readBody());
        const threshold = Number(thresholdUsd);
        const buyAmount = Number(buyAmountUsd);
        const slippage = Number(slippagePct);
        const cooldown = Number(cooldownMinutes);
        if (!(threshold > 0) || !(buyAmount > 0)) return json({ ok: false, error: "threshold and buy amount must be positive numbers" });
        if (!(slippage >= 0.1 && slippage <= 100)) return json({ ok: false, error: "slippage must be between 0.1% and 100%" });
        if (!Number.isInteger(cooldown) || cooldown < 1) return json({ ok: false, error: "cooldown must be a whole number of minutes" });
        // Validate the pool override BEFORE persisting (empty/"auto" clears it)
        let resolvedPool = null;
        try { resolvedPool = await resolvePoolOverride(watcher.contract_address, poolAddress ?? "", watcher.chain || "ethereum"); }
        catch (e) { return json({ ok: false, error: e.message }); }
        updateDipWatcherSettings(id, { thresholdUsd: threshold, buyAmountUsd: buyAmount, slippagePct: slippage, cooldownMinutes: cooldown });
        setDipWatcherPool(id, resolvedPool ? (resolvedPool.kind === "v4" ? resolvedPool.poolId : resolvedPool.address) : null);
        return json({ ok: true, watcher: getDipWatcher(id) });
      } catch (error) {
        return json({ ok: false, error: error.message });
      }
    }

    if (url.startsWith("/api/watchers/") && method === "DELETE") {
      const id = decodeURIComponent(url.replace("/api/watchers/", ""));
      const ownershipError = watcherOwnershipError(req, id);
      if (ownershipError) return json({ ok: false, error: ownershipError }, 403);
      removeDipWatcher(id);
      return json({ ok: true });
    }

    if (url === "/api/vault/create" && method === "POST") {
      try {
        const { name, email, password } = JSON.parse(await readBody());
        const r = await createVaultStart({ name, email, password });
        return json({ ok: true, vaultId: r.vaultId });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (url === "/api/vault/verify" && method === "POST") {
      try {
        const { code } = JSON.parse(await readBody());
        const st = await verifyVaultFinish({ code });
        writeEnvValues({ VAULT_ACTIVE: "true", VULT_FILE_PATH: st.path });
        return json({ ok: true, address: st.address });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (url === "/api/vault/import" && method === "POST") {
      try {
        const { content, password } = JSON.parse(await readBody());
        const st = await importVaultFile({ content, password });
        writeEnvValues({ VAULT_ACTIVE: "true", VULT_FILE_PATH: st.path, ...(password ? { VULTISIG_PASS: password } : {}) });
        return json({ ok: true, address: st.address });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    if (url === "/api/wallet" && method === "GET") {
      return await walletApiHandler({ isSignerConfigured, json, userId: sessionAddress(req) });
    }

    // Echoes the caller's OWN authenticated identity (from the session cookie)
    // — never a shared/global value. Replaces the old /api/wallet-connect GET,
    // which read a single .env CONNECTED_WALLET line shared by every user
    // (the 2026-09-19 "everyone sees the same wallet" bug). Header JS uses
    // this to restore the button label on load without a separate connect step.
    if (url === "/api/session" && method === "GET") {
      return json({ ok: true, address: sessionAddress(req) });
    }

    // Smart-wallet transfer UI (two-card owner↔SCW view in the wallet slideout)
    if (url === "/api/smart-wallet/status" && method === "GET") {
      try {
        const chainKey = requestUrl.searchParams.get("chain") || "ethereum";
        const { smartWalletStatus } = await import("./smart-wallet-api.mjs");
        // Session context: both cards are PER-USER now — the owner address AND
        // the SCW (or the generate-key prompt) belong to the logged-in user.
        // No client-submitted address anymore (that was a second copy of the
        // same "which wallet" question, answerable only from the cookie).
        return json(await smartWalletStatus(chainKey, { sessionAddress, req }));
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (url === "/api/smart-wallet/activate" && method === "POST") {
      try {
        const { chain } = JSON.parse(await readBody() || "{}");
        return json(await activateSmartWallet(chain || "ethereum"));
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    // Generate the burner session key server-side; returns the key ONCE (the
    // caller persists it to .env and the UI displays it for immediate backup).
    if (url === "/api/smart-wallet/generate" && method === "POST") {
      try {
        const { generateSessionKey } = await import("./smart-wallet-api.mjs");
        const { chain, force } = JSON.parse(await readBody() || "{}");
        const gen = await generateSessionKey(chain || "ethereum", { force: Boolean(force) });
        if (gen.ok) writeEnvValues({ AA_SESSION_KEY: gen.sessionKey });
        return json(gen);
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (url === "/api/smart-wallet/move" && method === "POST") {
      try {
        const body = JSON.parse(await readBody());
        return json(await moveFunds({
          direction: body.direction, asset: body.asset || "eth",
          amount: body.amount, chainKey: body.chain || "ethereum",
        }));
      } catch (e) { return json({ ok: false, error: e.message }); }
    }


    if (url === "/api/pm2-status" && method === "GET") {
      try {
        const out = execSync("pm2 jlist", { encoding: "utf8" });
        const list = JSON.parse(out).filter((p) => p.name?.startsWith("accumulate"));
        return json({ ok: true, processes: list.map((p) => ({ name: p.name, status: p.pm2_env?.status })) });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(err.message);
  }
});

// IMD USD price — from the ETH/IMD pool via Dexscreener (needs a UA header;
// bare fetches get 403). Feeds the engine's marketCap column. Execution
// pricing stays on-chain-only per CLAUDE.md — this is display evidence.
let imdUsd = 0;
async function refreshImdUsd() {
  try {
    const r = await fetch(
      "https://api.dexscreener.com/latest/dex/pairs/ethereum/0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3",
      { headers: { "User-Agent": "Mozilla/5.0 (IMD-Launchpad-Terminal)", "Accept": "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const p = (j.pairs || [])[0];
    if (p?.priceUsd) {
      imdUsd = Number(p.priceUsd);
      alphaEngine.data.imdUsd = imdUsd;   // engine recomputes marketCap on next tick
      alphaEngine.recompute();
    }
  } catch (e) {
    console.error(`[dashboard] imd price refresh failed: ${e.message}`);
  }
}

server.listen(PORT, () => {
  console.log(`\n🐴 IMD Launchpad Terminal`);
  console.log(`   http://localhost:${PORT}\n`);
  startSniperAutoSellLoop();
  refreshImdUsd();
  setInterval(refreshImdUsd, 60_000).unref();
});
