/**
 * mm-page.mjs — /mm page markup. Layout follows sniper-page.mjs conventions:
 * shell(), esc(), cards, pills, inline <script> with fetch-to-API pattern.
 */
import { getMmTrades, listMmStrategies } from "./mm-db.mjs";
import { resolveMmSigner } from "./signer.mjs";
import { getErc20Balance, getEthBalance } from "./dip-swap.mjs";
import { getChain } from "./chains.mjs";
function money(n, d = 2) {
  if (!(Number(n) > 0) && Number(n) !== 0) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
}

function cfg(s) {
  return {
    bid_offset_pct: s.bid_offset_pct, ask_offset_pct: s.ask_offset_pct,
    trade_size_usd: s.trade_size_usd, max_trade_usd: s.max_trade_usd,
    max_inventory_usd: s.max_inventory_usd, cooldown_minutes: s.cooldown_minutes,
    max_trades_per_day: s.max_trades_per_day, max_impact_pct: s.max_impact_pct,
    min_liquidity_usd: s.min_liquidity_usd, min_external_txns: s.min_external_txns,
    daily_loss_limit_usd: s.daily_loss_limit_usd, slippage_pct: s.slippage_pct,
    venue_override: s.venue_override ?? "",
  };
}

/**
 * MM wallet balances, fresh from the chain. Shared by the MM page render and
 * POST /api/mm/wallets (refresh icon) so both show identical numbers.
 * Display only — the daemon re-reads balances every poll regardless.
 */
export async function getMmWalletCards() {
  const strategies = listMmStrategies();
  const walletCards = [];
  for (const chain of [...new Set(strategies.map((s) => s.chain))]) {
    try {
      const signer = await resolveMmSigner(chain);
      const dep = getChain(chain);
      const [ethWei, usdgRaw, ...tokenBals] = await Promise.all([
        getEthBalance(signer.address, chain),
        getErc20Balance(dep.dollar, signer.address, chain).catch(() => 0n),
        ...strategies.filter((s) => s.chain === chain).map((s) => getErc20Balance(s.token_address, signer.address, chain).catch(() => 0n)),
      ]);
      const stratBalances = strategies.filter((s) => s.chain === chain).map((s, i) => {
        const raw = tokenBals[i] ?? 0n;
        return { symbol: s.symbol ?? s.token_address.slice(0, 6), human: Number(raw) / 10 ** 18 };
      });
      // Dollar token (USDG on 4663, USDC elsewhere) leads the token list —
      // it's the working capital every buy leg spends.
      const usdgBal = { symbol: dep.dollarDecimals === 6 ? (chain === "robinhood" ? "USDG" : "USDC") : "USD", human: Number(usdgRaw) / 10 ** (dep.dollarDecimals ?? 6) };
      walletCards.push({
        chain,
        address: signer.address,
        eth: Number(ethWei) / 1e18,
        tokens: [usdgBal, ...stratBalances],
      });
    } catch (e) {
      walletCards.push({ chain, error: String(e.message ?? e).slice(0, 80) });
    }
  }
  return walletCards;
}

/** One MM wallet accordion card — shared by server render and the refresh-icon client code. */
function mmWalletCardHtml(w, esc, money) {
  return `
  <details class="wallet-acc" ${w.error ? "" : "open"}>
    <summary>
      <span class="acc-chain">${esc(w.chain)}</span>
      <span class="acc-eth">${w.error ? "⚠ unavailable" : w.eth.toFixed(5) + " ETH"}</span>
    </summary>
    <div class="acc-body">
      ${w.error ? `<p class="hint">${esc(w.error)}</p>` : `
      <div class="acc-row"><span>ETH (gas)</span><b>${w.eth.toFixed(5)}</b></div>
      ${w.tokens.map((t) => `<div class="acc-row"><span>${esc(t.symbol)}</span><b>${money(t.human, 4)}</b></div>`).join("")}
    </div>`}
  </details>`;
}

export async function mmPage({ shell, esc, explorerLink, getChain }) {
  const strategies = listMmStrategies();
  const chains = ["robinhood"];

  const walletCards = await getMmWalletCards();

  const rows = strategies.map((s) => {
    const invUsd = (s.inventory_tokens ?? 0) * (s.last_price_usd ?? 0);
    return `
    <tr>
      <td>
        <div style="font-weight:600">${esc(s.symbol ?? s.token_address.slice(0, 10))}</div>
        <div class="hint">${esc(s.chain)}</div>
      </td>
      <td>${s.active ? '<span class="pill on">running</span>' : '<span class="pill off">paused</span>'}${s.dry_run ? ' <span class="pill" style="color:#e8b661;border-color:rgba(232,182,97,.4)">DRY</span>' : ""}</td>
      <td class="num">${s.last_price_usd ? "$" + Number(s.last_price_usd).toPrecision(6) : "—"}</td>
      <td class="num">±${money(s.bid_offset_pct, 1)} / ${money(s.ask_offset_pct, 1)}%</td>
      <td class="num">$${money(invUsd)}<br><span class="hint">basis $${money(s.cost_basis_usd)}</span></td>
      <td class="num" style="color:${(s.realized_pl_usd ?? 0) >= 0 ? "#4ade80" : "#f87171"}">${(s.realized_pl_usd ?? 0) >= 0 ? "+" : ""}$${money(s.realized_pl_usd)}</td>
      <td>${s.last_error ? `<span class="hint" title="${esc(s.last_error)}">⚠ ${esc(String(s.last_error).slice(0, 40))}</span>` : (s.last_trade_at ? esc(s.last_trade_at) : "—")}</td>
      <td>
        <button type="button" class="secondary" onclick="toggleStrategy('${s.id}', ${s.active ? 0 : 1})">${s.active ? "pause" : "run"}</button>
        <button type="button" class="secondary" onclick="editStrategy('${s.id}')">edit</button>
        <button type="button" class="${s.dry_run ? "secondary" : "danger"}" onclick="toggleDryWithConfirm('${s.id}', ${s.dry_run ? 0 : 1})">${s.dry_run ? "DRY — go live" : "LIVE — back to dry"}</button>
        <button type="button" class="danger" onclick="deleteStrategy('${s.id}')">del</button>
      </td>
    </tr>`;
  }).join("");

  const tradeRows = getMmTrades(40).map((t) => `
    <tr>
      <td>${esc(t.symbol ?? "—")}</td>
      <td>${t.created_at}</td>
      <td>${t.dry_run ? '<span class="hint">DRY</span>' : ""} ${esc(t.side)}</td>
      <td class="num">$${money(t.usd_size)}</td>
      <td class="num">${t.token_amount != null ? Number(t.token_amount).toPrecision(6) : "—"}</td>
      <td class="num">${t.price_usd ? "$" + Number(t.price_usd).toPrecision(6) : "—"}</td>
      <td>${t.impact_pct != null ? Number(t.impact_pct).toFixed(2) + "%" : "—"}</td>
      <td>${t.tx_hash ? explorerLink("robinhood", "tx", t.tx_hash, "view") : (t.error ? `<span class="hint" title="${esc(t.error)}">error</span>` : "—")}</td>
    </tr>`).join("");

  return shell("Market Maker", `
    <style>
      .mm-wrap { max-width: 1180px; margin: 0 auto; }
      .mm-grid { display:grid; grid-template-columns: 1fr 1fr; gap:1.25rem; }
      @media (max-width:900px) { .mm-grid { grid-template-columns:1fr; } }
      .mm-grid { display:grid; grid-template-columns:2fr 1fr; gap:1.25rem; }
      .num { font-variant-numeric:tabular-nums; }
      .gate-box { background:rgba(255,255,255,0.04); border-radius:8px; padding:0.75rem; margin-top:0.75rem; font-size:0.8rem; }
      .gate-row { display:flex; justify-content:space-between; padding:0.25rem 0; }
      .wallet-acc { border:1px solid rgba(255,255,255,0.09); border-radius:3px; margin-bottom:0.65rem; overflow:hidden; background:#0c0e11; }
      .wallet-acc summary { cursor:pointer; display:flex; justify-content:space-between; align-items:center; list-style:none; padding:0.55rem 0.75rem; font-size:0.8rem; user-select:none; background:#0c0e11; }
      .wallet-acc summary::-webkit-details-marker { display:none; }
      .wallet-acc summary:hover { background:rgba(232,182,97,0.06); }
      .wallet-acc summary .acc-chain { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:0.78rem; }
      .wallet-acc summary .acc-eth { margin-left:auto; font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:0.78rem; color:rgba(255,255,255,0.55); }
      .wallet-acc[open] summary { border-bottom:1px solid rgba(255,255,255,0.05); }
      .wallet-acc .acc-body { padding:0.45rem 0.75rem 0.55rem; }
      .wallet-acc .acc-addr { font-size:0.68rem; word-break:break-all; color:rgba(255,255,255,0.42); font-family:ui-monospace,"SF Mono",Menlo,monospace; margin-bottom:0.4rem; }
      .wallet-acc .acc-row { display:flex; justify-content:space-between; align-items:center; padding:0.28rem 0; font-size:0.74rem; border-top:1px solid rgba(255,255,255,0.05); font-variant-numeric:tabular-nums; }
      .wallet-acc .acc-row b { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:0.76rem; font-weight:600; }
      .wallet-acc .acc-note { font-size:0.66rem; color:rgba(255,255,255,0.42); margin-top:0.45rem; }
    </style>
    <div class="mm-wrap">
      <div class="stat-row">
        <div class="stat-card"><div class="label">Strategies</div><div class="value">${strategies.length}</div><div class="sub">${strategies.filter(s=>s.active).length} running</div></div>
        <div class="stat-card"><div class="label">Realized P/L</div><div class="value">$${money(strategies.reduce((a,s)=>a+(s.realized_pl_usd??0),0))}</div><div class="sub">all strategies, lifetime</div></div>
        <div class="stat-card"><div class="label">Inventory value</div><div class="value">$${money(strategies.reduce((a,s)=>a+((s.inventory_tokens??0)*(s.last_price_usd??0)),0))}</div><div class="sub">across strategies</div></div>
        <div class="stat-card"><div class="label">Trades (all)</div><div class="value">${getMmTrades(1000).length}</div><div class="sub">last 1000 shown below</div></div>
        <div class="stat-card"><div class="label">Mode</div><div class="value">${strategies.some(s=>s.active && !s.dry_run) ? "LIVE" : "DRY-RUN"}</div><div class="sub">live only when a strategy runs with DRY off</div></div>
      </div>

      <div class="mm-grid">
        <div class="card">
          <h2>New market-making strategy</h2>
          <div class="field"><label>Token contract address (Robinhood Chain)</label>
            <input id="nToken" placeholder="0x… (e.g. your ATLANTIS 0x2691…1e18)"></div>
          <div id="nMeta" class="hint" style="margin-bottom:0.75rem">venue + pool are auto-discovered; stock-token pairs (e.g. /MU) are supported</div>
          <div class="row">
            <div class="field"><label>Bid offset % (buy below fair)</label><input id="nBid" type="number" step="0.1" min="0.1" value="1.0"></div>
            <div class="field"><label>Ask offset % (sell above fair)</label><input id="nAsk" type="number" step="0.1" min="0.1" value="1.0"></div>
          </div>
          <div class="row">
            <div class="field"><label>Trade size ($)</label><input id="nSize" type="number" min="1" value="25"></div>
            <div class="field"><label>Max inventory ($)</label><input id="nInv" type="number" min="10" value="500"></div>
          </div>
          <div class="row">
            <div class="field"><label>Cooldown (min)</label><input id="nCooldown" type="number" min="1" value="10"></div>
            <div class="field"><label>Max trades/day</label><input id="nCap" type="number" min="1" value="12"></div>
          </div>
          <div class="row">
            <div class="field"><label>Max impact (%)</label><input id="nImpact" type="number" step="0.1" min="0.1" value="2"></div>
            <div class="field"><label>Daily loss limit ($)</label><input id="nLoss" type="number" min="1" value="50"></div>
          </div>
          <div class="field"><label>Min pool liquidity ($)</label><input id="nLiq" type="number" min="0" value="5000"></div>
          <div class="field"><label>Min external txns / 5m (anti self-cross)</label><input id="nExt" type="number" min="0" value="2"></div>
          <div class="field"><label>Venue override — V4 poolId (optional)</label><input id="nVenue" placeholder="0x… (blank = auto-discover)"></div>
          <div class="gate-box">
            <div style="font-weight:600;margin-bottom:0.35rem">Built-in safety rails (always on)</div>
            <div class="gate-row"><span>Never same side twice in a row</span><span class="pill on">on</span></div>
            <div class="gate-row"><span>Only trades against external flow</span><span class="pill on">on</span></div>
            <div class="gate-row"><span>Trade cap / day</span><span class="hint">max_trades_per_day</span></div>
            <div class="gate-row"><span>Daily loss limit</span><span class="hint">stops on breach</span></div>
            <div class="gate-row"><span>Inventory cap</span><span class="hint">max_inventory_usd</span></div>
            <div class="gate-row"><span>Price-impact cap</span><span class="hint">max_impact_pct</span></div>
            <div class="gate-row"><span>Liquidity floor</span><span class="hint">min_liquidity_usd</span></div>
            <div class="gate-row"><span>Error auto-pause</span><span class="hint">5 consecutive errors</span></div>
          </div>
          <button type="button" onclick="createStrategy()">Create strategy (starts paused, dry-run)</button>
          <span id="nStatus" class="hint" style="margin-left:0.75rem"></span>
        </div>

        <div>
          <div class="card">
            <h2 style="display:flex;justify-content:space-between;align-items:center">MM wallets
              <button type="button" class="secondary" id="mmWalletRefresh" onclick="refreshMmWallets(this)" title="Refresh balances" style="display:inline-flex;align-items:center;gap:0.35rem;padding:0.3rem 0.6rem;font-size:0.78rem">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-5.95h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                Refresh
              </button>
            </h2>
            <div id="mmWalletCards">${walletCards.map((w) => mmWalletCardHtml(w, esc, money)).join("")}
            ${walletCards.length === 0 ? '<p class="hint">No strategies yet — the MM wallet appears once a strategy exists.</p>' : ""}</div>
          </div>
          <div class="card">
            <h2>How it works</h2>
            <p class="hint" style="line-height:1.6">
              An AMM has no order book, so this bot is a <b>two-sided inventory bot</b>:
              it prices the token from the pool's own spot, and buys when external
              selling pushes price to your bid offset, sells when external buying
              pushes it to your ask offset — capturing the round-trip spread on
              someone else's flow, never manufacturing volume.
              For stock-paired pools (e.g. ATLANTIS/MU) the quote token is priced
              via its own USDG pool, so sizing stays in dollars throughout.
              Every leg is quoted through the real V4 quoter with a hard min-out,
              and dry-run mode exercises the full decision loop without sending
              transactions.
            </p>
          </div>
          <div class="card">
            <h2>Per-strategy config</h2>
            <div class="field"><label>Strategy</label><select id="eSel" onchange="loadStrategy()">${strategies.map((s)=>`<option value="${s.id}">${esc(s.symbol ?? s.token_address.slice(0,10))}</option>`).join("") || "<option>— none —</option>"}</select></div>
            <div id="eForm"><p class="hint">Create a strategy first.</p></div>
          </div>
<script id="mm-strategies-data" type="application/json">${JSON.stringify(strategies.map((s) => ({ id: s.id, symbol: s.symbol, chain: s.chain, bid_offset_pct: s.bid_offset_pct, ask_offset_pct: s.ask_offset_pct, trade_size_usd: s.trade_size_usd, max_trade_usd: s.max_trade_usd, max_inventory_usd: s.max_inventory_usd, cooldown_minutes: s.cooldown_minutes, max_trades_per_day: s.max_trades_per_day, max_impact_pct: s.max_impact_pct, min_liquidity_usd: s.min_liquidity_usd, min_external_txns: s.min_external_txns, daily_loss_limit_usd: s.daily_loss_limit_usd, slippage_pct: s.slippage_pct, venue_override: s.venue_override }))).replace(/</g, "\\u003c")}</script>
        </div>
      </div>

      <div class="card">
        <h2>Strategies</h2>
        ${strategies.length ? `<table><thead><tr><th>Token</th><th>Status</th><th>Price</th><th>Offsets</th><th>Inventory</th><th>Realized P/L</th><th>Last</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="hint">No strategies yet.</p>`}
      </div>

      <div class="card">
        <h2>MM activity</h2>
        ${tradeRows ? `<table><thead><tr><th>Token</th><th>When</th><th>Side</th><th>Size</th><th>Tokens</th><th>Price</th><th>Impact</th><th>Tx</th></tr></thead><tbody>${tradeRows}</tbody></table>` : `<p class="hint">No MM trades yet.</p>`}
      </div>
    </div>

    <script>
      function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

      async function refreshMmWallets(btn) {
        if (btn) { btn.disabled = true; btn.style.opacity = "0.6"; }
        const el = document.getElementById("mmWalletCards");
        try {
          const r = await fetch("/api/mm/wallets", { method: "POST", headers: {"Content-Type":"application/json"}, body: "{}" });
          const j = await r.json();
          if (!j.ok) { el.innerHTML = '<p class="hint">' + esc(j.error || "unavailable") + '</p>'; return; }
          if (!j.cards.length) { el.innerHTML = '<p class="hint">No strategies yet — the MM wallet appears once a strategy exists.</p>'; return; }
          el.innerHTML = j.cards.map((w) => {
            const money2 = (n, d = 2) => (!(Number(n) > 0) && Number(n) !== 0 ? "—" : Number(n).toLocaleString(void 0, { maximumFractionDigits: d }));
            return '<details class="wallet-acc" ' + (w.error ? "" : "open") + '>' +
              '<summary><span class="acc-chain">' + esc(w.chain) + '</span>' +
              '<span class="acc-eth">' + (w.error ? "⚠ unavailable" : Number(w.eth).toFixed(5) + " ETH") + '</span></summary>' +
              '<div class="acc-body">' + (w.error
                ? '<p class="hint">' + esc(w.error) + '</p>'
                : '<div class="acc-row"><span>ETH (gas)</span><b>' + Number(w.eth).toFixed(5) + '</b></div>' +
                  w.tokens.map((t) => '<div class="acc-row"><span>' + esc(t.symbol) + '</span><b>' + money2(t.human, 4) + '</b></div>').join("")) +
              '</div></details>';
          }).join("");
        } catch (e) { el.innerHTML = '<p class="hint">' + esc(e.message) + '</p>'; }
        finally { if (btn) { btn.disabled = false; btn.style.opacity = ""; } }
      }

      async function createStrategy() {
        const status = document.getElementById("nStatus");
        const token = document.getElementById("nToken").value.trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(token)) { status.textContent = "invalid token address"; return; }
        status.textContent = "creating (resolving pool)...";
        try {
          const r = await fetch("/api/mm/strategies", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({
            chain: "robinhood", token_address: token,
            bid_offset_pct: document.getElementById("nBid").value,
            ask_offset_pct: document.getElementById("nAsk").value,
            trade_size_usd: document.getElementById("nSize").value,
            max_inventory_usd: document.getElementById("nInv").value,
            cooldown_minutes: document.getElementById("nCooldown").value,
            max_trades_per_day: document.getElementById("nCap").value,
            max_impact_pct: document.getElementById("nImpact").value,
            daily_loss_limit_usd: document.getElementById("nLoss").value,
            min_liquidity_usd: document.getElementById("nLiq").value,
            min_external_txns: document.getElementById("nExt").value,
            venue_override: document.getElementById("nVenue").value.trim() || null,
          })});
          const j = await r.json();
          if (j.ok) { status.textContent = "created (" + (j.strategy?.symbol ?? "token") + ") — paused + dry-run. Arm it from the table."; setTimeout(()=>location.reload(), 900); }
          else status.textContent = j.error;
        } catch (e) { status.textContent = e.message; }
      }

      async function toggleStrategy(id) {
        const r = await fetch("/api/mm/toggle", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id }) });
        const j = await r.json();
        if (!j.ok) alert(j.error); else location.reload();
      }

      function mmStrategies() {
        try { return JSON.parse(document.getElementById("mm-strategies-data").textContent); }
        catch { return []; }
      }

      const MM_EDIT_FIELDS = [
        ["bid_offset_pct", "Bid offset % (buy below fair)"],
        ["ask_offset_pct", "Ask offset % (sell above fair)"],
        ["trade_size_usd", "Trade size ($)"],
        ["max_trade_usd", "Max trade ($)"],
        ["max_inventory_usd", "Max inventory ($)"],
        ["cooldown_minutes", "Cooldown (min)"],
        ["max_trades_per_day", "Max trades/day"],
        ["max_impact_pct", "Max impact (%)"],
        ["daily_loss_limit_usd", "Daily loss limit ($)"],
        ["min_liquidity_usd", "Min pool liquidity ($)"],
        ["min_external_txns", "Min external txns / window"],
        ["slippage_pct", "Slippage (%)"],
      ];

      function loadStrategy() {
        const id = document.getElementById("eSel").value;
        const s = mmStrategies().find((x) => x.id === id);
        const el = document.getElementById("eForm");
        if (!s) { el.innerHTML = '<p class="hint">Create a strategy first.</p>'; return; }
        let html = "";
        for (const [k, label] of MM_EDIT_FIELDS) {
          html += '<div class="field"><label>' + label + '</label><input id="e_' + k + '" type="number" step="any" value="' + (s[k] ?? "") + '"></div>';
        }
        html += '<div class="field"><label>Venue override — V4 poolId (blank = auto)</label><input id="e_venue_override" value="' + esc(s.venue_override ?? "") + '"></div>';
        html += '<p class="hint" style="margin:0.5rem 0">Token (' + esc(s.symbol ?? "") + ') and chain are fixed after creation — create a new strategy to trade a different token.</p>';
        html += '<button type="button" onclick="saveStrategy()">Save changes</button> <span id="eStatus" class="hint" style="margin-left:0.5rem"></span>';
        el.innerHTML = html;
      }

      async function saveStrategy() {
        const id = document.getElementById("eSel").value;
        const status = document.getElementById("eStatus");
        const patch = {};
        for (const [k] of MM_EDIT_FIELDS) patch[k] = document.getElementById("e_" + k).value;
        patch.venue_override = document.getElementById("e_venue_override").value.trim() || null;
        status.textContent = "saving…";
        try {
          const r = await fetch("/api/mm/strategies", { method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id, ...patch }) });
          const j = await r.json();
          status.textContent = j.ok ? "saved ✓ (applies on the next 20s poll)" : (j.error ?? "error");
        } catch (e) { status.textContent = e.message; }
      }

      function editStrategy(id) {
        // Jump to the per-strategy editor and load this strategy into it.
        const sel = document.getElementById("eSel");
        if (sel) {
          sel.value = id;
          loadStrategy();
          sel.closest(".card").scrollIntoView({ behavior: "smooth" });
        }
      }

      async function deleteStrategy(id) {
        if (!confirm("Delete this strategy and its trade log?")) return;
        const r = await fetch("/api/mm/strategies/" + id, { method: "DELETE" });
        const j = await r.json();
        if (!j.ok) alert(j.error); else location.reload();
      }

      async function toggleDry(id) {
        const r = await fetch("/api/mm/dry", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id }) });
        const j = await r.json();
        if (!j.ok) alert(j.error); else location.reload();
      }

      async function toggleDryWithConfirm(id, goingLive) {
        const msg = goingLive
          ? "Switch this strategy to LIVE? Real transactions will be sent from the dedicated MM wallet, sized against its real balances. Safety rails stay on (alternation, cooldown, daily loss limit, inventory cap, impact cap)."
          : "Switch this strategy back to dry-run? No further transactions will be sent.";
        if (!confirm(msg)) return;
        toggleDry(id);
      }
    </script>
  `, "mm");
}
