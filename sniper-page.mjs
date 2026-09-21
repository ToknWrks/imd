/**
 * sniper-page.mjs — /sniper page markup. Layout follows toknwrks-main sniper3.
 */
import { getSniperTrades } from "./db.mjs";

function money(n, d = 2) {
  if (!(Number(n) > 0) && Number(n) !== 0) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
}

export function sniperPage({ shell, esc, explorerLink, getChain, ctx, userId = null }) {
  // Per-user (2026-09-19): the trades list shows ONLY the session user's
  // ledger (+ NULL-legacy rows). Previously unscoped — everyone saw everyone.
  const trades = getSniperTrades(30, userId);
  const ethUsd = Number(ctx?.ethUsd || 0);
  const defaultEth = 0.01;
  const defaultUsd = ethUsd > 0 ? (defaultEth * ethUsd).toFixed(2) : "—";
  const chain = ctx?.chain || "ethereum";

  const rows = trades.map((t) => {
    const usd = t.eth_spent != null && ethUsd > 0 ? `$${money(t.eth_spent * ethUsd)}` : "";
    return `
    <tr>
      <td>${t.created_at}</td>
      <td>${esc(t.chain)}</td>
      <td>${esc(t.symbol ?? t.contract_address)}</td>
      <td>${esc(t.dex ?? "—")}</td>
      <td>${t.eth_spent != null ? Number(t.eth_spent).toFixed(4) + " ETH" : "—"}${usd ? `<br><span class="hint">${usd}</span>` : ""}</td>
      <td>${t.token_amount != null ? Number(t.token_amount).toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}</td>
      <td><span class="pill ${t.status === "ok" ? "on" : "off"}" style="${t.status !== "ok" ? "color:#f87171;border-color:rgba(248,113,113,0.3)" : ""}">${t.status}</span></td>
      <td>${t.buy_tx_hash ? explorerLink(t.chain, "tx", t.buy_tx_hash, "view") : (t.error ? `<span class="hint" title="${esc(t.error)}">error</span>` : "—")}</td>
    </tr>`;
  }).join("");

  return shell("Sniper", `
    <style>
      .sniper-wrap { max-width: 1080px; margin: 0 auto; }
      .sniper-grid { display:grid; grid-template-columns:2fr 1fr; gap:1.25rem; }
      @media (max-width:900px) { .sniper-grid { grid-template-columns:1fr; } }
      .usd-line { margin-top:0.35rem; font-size:0.85rem; color:#A8F1F7; font-weight:600; }
      .pair-tabs { display:grid; grid-template-columns:1fr 1fr; gap:0.5rem; margin-bottom:0.75rem; }
      .pair-tabs button { padding:0.7rem 0.5rem; }
      .pair-tabs button.on { background:#2a2e35; color:#fff; }
      .pool-row { display:flex; justify-content:space-between; align-items:center; padding:0.6rem 0.7rem; border:1px solid rgba(255,255,255,0.08); border-radius:8px; margin-bottom:0.5rem; }
      .pool-row.chosen { border-color:#4f46e5; background:rgba(79,70,229,0.08); }
      .pool-row button { padding:0.35rem 0.8rem; font-size:0.8rem; }
      .approval-row { display:flex; justify-content:space-between; align-items:center; padding:0.5rem 0; border-bottom:1px solid rgba(255,255,255,0.06); }
      .approval-row:last-child { border-bottom:none; }
      .pl-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:0.75rem; margin:0.75rem 0 0.9rem; }
      .pl-label { font-size:0.72rem; color:rgba(255,255,255,0.55); text-transform:uppercase; letter-spacing:0.04em; }
      .pl-value { font-size:0.82rem; font-weight:600; margin-top:0.2rem; }
      .pl-pos { color:#4ade80; }
      .pl-neg { color:#f87171; }
    </style>
    <div class="sniper-wrap">
      <div class="sniper-grid">
        <div>
          <div class="card">
            <h2>Token</h2>
            <div class="field"><label>Contract address</label><input id="token" placeholder="0x… (type to search remembered tokens)" list="tokenHistory" autocomplete="off"></div>
            <datalist id="tokenHistory"></datalist>
            <button type="button" onclick="discover()">Check liquidity</button>
            <!-- Verify-sellable button hidden (UI cleanup, 2026-09-16): the probe
                 plumbing (verify-ui.mjs / sell-probe.mjs / /api/sniper/verify) is
                 untouched and still backs exit auto-pause + autosell-arm refusal.
                 To restore, re-add the button + verifyBadge span here. -->
            <span id="verifyBadge" style="display:none;margin-left:0.5rem"></span>
            <span id="status" class="hint" style="margin-left:0.75rem"></span>
          </div>
          <div class="card">
            <h2>Trade settings</h2>
            <label>Base token</label>
            <div class="pair-tabs">
              <button type="button" id="baseEth" class="on" onclick="setBase('ETH')">ETH</button>
              <button type="button" id="baseImd" class="secondary" onclick="setBase('IMD')">IMD</button>
            </div>
            <div class="row">
              <div class="field">
                <label id="amountLabel">Buy Amount (ETH)</label>
                <input id="buyAmount" type="number" step="0.01" min="0" value="0.01" oninput="syncUsd()">
                <p class="usd-line" id="usdLine">≈ $${defaultUsd} USD</p>
              </div>
              <div class="field">
                <label>Max Gas (Gwei)</label>
                <input id="maxGas" type="number" step="0.001" min="0" value="10">
              </div>
            </div>
            <div class="field">
              <label>Slippage Tolerance (%)</label>
              <input id="slippage" type="number" step="0.1" min="0.1" value="3">
            </div>
            <button type="button" onclick="buyNow()">Buy now</button>
            <span id="buyStatus" class="hint" style="margin-left:0.75rem"></span>
          </div>
          <div class="card">
            <h2>Pools</h2>
            <div id="pools"><p class="hint">Paste a token and check liquidity.</p></div>
          </div>
        </div>
        <div>
          <div class="card">
            <h2>Profit &amp; Loss</h2>
            <div class="pl-grid">
              <div>
                <div class="pl-label">Holdings</div>
                <div class="pl-value" id="plBalance">—</div>
                <div class="hint" id="plValueUsd"></div>
              </div>
              <div>
                <div class="pl-label">Net cost (ETH)</div>
                <div class="pl-value" id="plNetCost">—</div>
                <div class="hint" id="plBuysSells"></div>
              </div>
              <div>
                <div class="pl-label">Realized P/L</div>
                <div class="pl-value" id="plRealized">—</div>
                <div class="hint" id="plRealizedEth"></div>
              </div>
              <div>
                <div class="pl-label">Unrealized P/L</div>
                <div class="pl-value" id="plUnrealized">—</div>
                <div class="hint" id="plUnrealizedEth"></div>
              </div>
            </div>
            <button class="secondary" type="button" onclick="loadPL()" title="Refresh P/L from the ledger + live quote" style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13.7 2.5v3.2h-3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <button class="secondary" type="button" onclick="walletSync()" title="Pull trades made outside the app (e.g. sold via Uniswap UI) into the ledger" style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8.5 1L3 9h4l-1.5 6L11.5 7h-4L8.5 1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
            </button>
            <span id="plStatus" class="hint" style="margin-left:0.5rem"></span>
            <div id="plNote" class="hint" style="margin-top:0.6rem;display:none"></div>
            <div style="margin-top:0.9rem;padding:0.85rem;background:rgba(255,255,255,0.04);border-radius:8px">
              <div style="font-weight:600">Auto-Sell</div>
              <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.5rem">
                <input id="asTarget" type="number" step="5" min="1" value="50" style="width:80px">
                <span class="hint">%&nbsp;gain</span>
                <button class="secondary" type="button" onclick="armAutoSell()">Arm</button>
                <button class="secondary" type="button" onclick="cancelAutoSell()">Cancel</button>
              </div>
              <div class="hint" style="margin-top:0.45rem">Sell 100% when value ≥ cost × (1 + target). Armed orders run server-side and survive page reloads.</div>
            </div>
            <span id="asStatus" class="hint"></span>
            <div id="asOrders" style="margin-top:0.5rem"></div>
          </div>
          <div class="card">
            <h2>Sell</h2>
            <div class="field"><label>Sell % of balance</label><input id="sellPct" type="number" min="1" max="100" value="100"></div>
            <button class="secondary" type="button" onclick="sellNow()">Sell now</button>
            <button class="secondary" type="button" onclick="accumulateToken()">Accumulate</button>
            <span id="sellStatus" class="hint" style="margin-left:0.5rem"></span>
          </div>
        </div>
      </div>
      <div class="card">
        <h2>Activity</h2>
        ${trades.length ? `<table><thead><tr><th>When</th><th>Chain</th><th>Token</th><th>DEX</th><th>Spent</th><th>Tokens</th><th>Status</th><th>Tx</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="hint">No sniper trades yet.</p>`}
      </div>
    </div>
    <script>
      let ctx = ${JSON.stringify({ chain, ethUsd, ethBalance: ctx?.ethBalance ?? 0, ethUsdValue: ctx?.ethUsdValue ?? 0, imdPerEth: ctx?.imdPerEth ?? 0, activeToken: ctx?.activeToken ?? null })};
      let base = "ETH";
      let lastDiscover = null;
      let chosenPool = null;

      function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

      function iconUrl(chain, addr, sym) {
        return "/api/icon/token/" + encodeURIComponent(chain) + "/" + addr + "?s=" + encodeURIComponent(sym || "");
      }

      let recentTokens = [];
      // Memory lives in the input's datalist — no chip strip. Each remembered
      // token is an option (label = symbol + truncated address for readability;
      // the input itself always carries the full address).
      function renderRecent() {
        const dl = document.getElementById("tokenHistory");
        dl.innerHTML = recentTokens.map((t) => {
          const label = (t.symbol || "token") + " · " + t.contract_address.slice(0, 6) + "…" + t.contract_address.slice(-4);
          return '<option value="' + t.contract_address + '">' + esc(label) + "</option>";
        }).join("");
      }

      async function loadRecent() {
        try {
          const r = await fetch("/api/sniper/recent", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ chain: ctx.chain }) });
          const j = await r.json();
          if (!j.ok) return null;
          recentTokens = j.tokens || [];
          renderRecent();
          return j.active || null;
        } catch { return null; }
      }

      // A genuinely new token wipes ALL prior-token state: pools, discovery,
      // P/L render, autosell list focus. Everything below re-derives from the
      // new address only.
      let currentToken = null;
      function resetForNewToken(addr) {
        if (currentToken === addr) return false;
        currentToken = addr;
        lastDiscover = null;
        chosenPool = null;
        const poolsEl = document.getElementById("pools");
        poolsEl.innerHTML = '<p class="hint">Checking liquidity…</p>';
        return true;
      }

      async function pickRecent(addr) {
        document.getElementById("token").value = addr;
        await discover();
      }

      function renderCtx() {
        syncUsd();
      }

      function setBase(which) {
        base = which;
        document.getElementById("baseEth").classList.toggle("on", which === "ETH");
        document.getElementById("baseEth").classList.toggle("secondary", which !== "ETH");
        document.getElementById("baseImd").classList.toggle("on", which === "IMD");
        document.getElementById("baseImd").classList.toggle("secondary", which !== "IMD");
        document.getElementById("amountLabel").textContent = which === "ETH" ? "Buy Amount (ETH)" : "Buy Amount (IMD, sized in ETH)";
        syncUsd();
      }

      function syncUsd() {
        const amt = parseFloat(document.getElementById("buyAmount").value) || 0;
        const usdLine = document.getElementById("usdLine");
        if (base === "IMD") {
          // IMD mode: show ETH equivalent (and USD when both rates are live).
          if (!(ctx.imdPerEth > 0)) { usdLine.textContent = "≈ — ETH (ETH/IMD rate unavailable)"; return; }
          const eth = amt / ctx.imdPerEth;
          usdLine.textContent = "≈ " + eth.toLocaleString(undefined, {maximumFractionDigits:6}) + " ETH" +
            (ctx.ethUsd > 0 ? " · $" + (eth * ctx.ethUsd).toLocaleString(undefined, {maximumFractionDigits:2}) + " USD" : "");
          return;
        }
        if (!(ctx.ethUsd > 0)) { usdLine.textContent = "≈ $— USD"; return; }
        usdLine.textContent = "≈ $" + (amt * ctx.ethUsd).toLocaleString(undefined, {maximumFractionDigits:2}) + " USD";
      }

      function ethAmountForBuy() {
        const amt = parseFloat(document.getElementById("buyAmount").value) || 0;
        if (base === "ETH") return amt;
        // IMD base: convert at the live ETH/IMD pool rate; the buy itself
        // always pays ETH (the server-side route is ETH-funded by design —
        // every venue on this platform routes through ETH).
        if (!(ctx.imdPerEth > 0)) throw new Error("ETH/IMD rate unavailable");
        return amt / ctx.imdPerEth;
      }

      async function discover() {
        const token = document.getElementById("token").value.trim();
        const status = document.getElementById("status");
        if (!/^0x[0-9a-fA-F]{40}$/.test(token)) { status.textContent = "invalid address"; return; }
        status.textContent = "checking...";
        resetForNewToken(token); // new token → wipe pools/chosen pool from the previous one
        chosenPool = null;
        loadPL(); // P/L card follows the token in the address box
        loadAutoSells(); // autosell list re-focuses on this token
        renderVerifyBadge(token); // verified-state badge follows the token
        try {
          const ethAmount = ethAmountForBuy() || 0.01;
          const r = await fetch("/api/sniper/discover", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ chain: ctx.chain, token, ethAmount: String(ethAmount) }) });
          const j = await r.json();
          if (!j.ok) { status.textContent = j.error; document.getElementById("pools").innerHTML = ""; return; }
          lastDiscover = j;
          status.textContent = j.symbol ? "found " + j.symbol : "found";
          renderPools();
        } catch (e) { status.textContent = e.message; }
      }

      // ── Honeypot verification (buy ~$2 → sell → confirm proceeds) ──────────
      function renderVerifyBadge(token) {
        const el = document.getElementById("verifyBadge");
        const info = recentTokens.find((t) => t.contract_address?.toLowerCase() === (token || "").toLowerCase());
        if (info?.verified_at) {
          el.innerHTML = '<span class="pill on" title="A buy+sell round-trip delivered proceeds to the wallet (' + esc(info.verified_via || "probe") + ', ' + esc(info.verified_at) + ')" style="color:#4ade80;border-color:rgba(74,222,128,0.4);font-size:0.7rem;padding:0.15rem 0.45rem">✓ sellable</span>';
        } else {
          el.innerHTML = '<span class="hint" style="font-size:0.7rem">not verified</span>';
        }
      }

      async function verifyToken() {
        const btn = document.getElementById("verifyBtn");
        const badge = document.getElementById("verifyBadge");
        const status = document.getElementById("status");
        const token = document.getElementById("token").value.trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(token)) { status.textContent = "enter a valid token address"; return; }
        if (!lastDiscover || !chosenPool) { status.textContent = "check liquidity first"; return; }
        if (currentToken !== token) { status.textContent = "token changed — check liquidity first"; return; }
        btn.disabled = true;
        status.textContent = "verifying — buying ~$2 then selling it back (this takes ~1-2 min on Robinhood)…";
        try {
          const r = await fetch("/api/sniper/verify", {
            method: "POST", headers: {"Content-Type":"application/json"},
            body: JSON.stringify({
              chain: ctx.chain, token, symbol: lastDiscover.symbol, decimals: lastDiscover.decimals,
              pool: chosenPool, maxGasGwei: document.getElementById("maxGas").value,
            }),
          });
          const j = await r.json();
          if (!j.ok) { status.textContent = j.error; return; }
          if (j.verified) {
            badge.innerHTML = '<span style="color:#4ade80;font-size:0.7rem;padding:0.15rem 0.45rem;border:1px solid rgba(74,222,128,0.4);border-radius:999px">✓ sellable</span>';
            status.textContent = "VERIFIED — buy and sell both delivered (probe " + Number(j.probeEth).toFixed(4) + " ETH).";
            loadRecent(); // refresh the datalist so the badge persists across reloads
            loadPL();
          } else {
            status.textContent = "NOT sellable: " + (j.reason || "the sell delivered nothing");
            badge.innerHTML = '<span style="color:#f87171;font-size:0.7rem;padding:0.15rem 0.45rem;border:1px solid rgba(248,113,113,0.4);border-radius:999px">✗ trap</span>';
          }
        } catch (e) { status.textContent = e.message; }
        finally { btn.disabled = false; }
      }

      function renderPools() {
        const el = document.getElementById("pools");
        if (!lastDiscover?.pools?.length) {
          // Curve coins (IMD launchpad) have no AMM venues at all — that's the
          // token's normal state, not an error. Treat discovery-ok-but-empty as
          // curve mode: the buy/sell routes dispatch through the bonding curve.
          chosenPool = { dex: "CURVE", label: "IMD bonding curve" };
          el.innerHTML = '<div class="pool-row chosen"><div><div style="font-weight:600">IMD bonding curve</div>' +
            '<div class="hint">launchpad curve — no AMM pool; buys route through the hook</div></div>' +
            '<span class="pill on" style="font-size:0.62rem">CURVE</span></div>';
          return;
        }
        el.innerHTML = lastDiscover.pools.map((p, i) => {
          const on = chosenPool && chosenPool.dex === p.dex && chosenPool.label === p.label;
          if (!chosenPool && i === 0) chosenPool = p;
          return '<div class="pool-row ' + (i === 0 && !on ? "chosen" : (on ? "chosen" : "")) + '" data-idx="' + i + '">' +
            '<div><div style="font-weight:600">' + esc(p.label) + '</div><div class="hint">' + esc(p.quotedOutFormatted) + ' ' + esc(lastDiscover.symbol) + '</div></div>' +
            '<button type="button" class="secondary" onclick="choosePool(' + i + ')">use</button></div>';
        }).join("");
      }

      function choosePool(i) {
        chosenPool = lastDiscover.pools[i];
        renderPools();
      }

      async function buyNow() {
        const status = document.getElementById("buyStatus");
        const token = document.getElementById("token").value.trim();
        if (!lastDiscover || !chosenPool) { status.textContent = "check liquidity first"; return; }
        // Hard guard: the chosen pool must belong to the token in the box.
        // (A stale chosenPool from a previous token sent a real buy through a
        // pool that didn't contain the token — reverted InsufficientETH.)
        if (currentToken !== token) { status.textContent = "token changed — check liquidity first"; return; }
        status.textContent = "buying...";
        try {
          const ethAmount = ethAmountForBuy();
          const body = {
            chain: ctx.chain,
            token,
            symbol: lastDiscover.symbol,
            decimals: lastDiscover.decimals,
            ethAmount: String(ethAmount),
            slippagePct: document.getElementById("slippage").value,
            maxGasGwei: document.getElementById("maxGas").value,
            pool: chosenPool,
          };
          const j = await window.directSignTrade("/api/sniper/buy", body, (m) => { status.textContent = m; });
          status.textContent = j.ok ? "bought — tx " + j.txHash.slice(0, 10) + "…" : j.error;
          if (j.ok) setTimeout(() => location.reload(), 1200);
        } catch (e) { status.textContent = e.message; }
      }

      function plClass(v) { return v > 0 ? "pl-pos" : (v < 0 ? "pl-neg" : ""); }

      // ── Auto-Sell ──────────────────────────────────────────────────────────
      async function armAutoSell() {
        const token = document.getElementById("token").value.trim();
        const status = document.getElementById("asStatus");
        if (!/^0x[0-9a-fA-F]{40}$/.test(token)) { status.textContent = "enter a valid token address first"; return; }
        status.textContent = "arming...";
        try {
          const r = await fetch("/api/sniper/autosell/arm", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ chain: ctx.chain, token, targetPct: document.getElementById("asTarget").value }) });
          const j = await r.json();
          if (!j.ok) { status.textContent = j.error; return; }
          status.textContent = "armed — sells 100% when value ≥ " + Number(j.targetEth).toFixed(4) + " ETH (cost " + Number(j.costEth).toFixed(4) + " + " + document.getElementById("asTarget").value + "%)";
          loadAutoSells();
        } catch (e) { status.textContent = e.message; }
      }

      async function cancelAutoSell() {
        const token = document.getElementById("token").value.trim();
        const status = document.getElementById("asStatus");
        if (!/^0x[0-9a-fA-F]{40}$/.test(token)) { status.textContent = "enter a valid token address first"; return; }
        try {
          const r = await fetch("/api/sniper/autosell/cancel", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ chain: ctx.chain, token }) });
          const j = await r.json();
          status.textContent = j.ok ? (j.cancelled > 0 ? "cancelled " + j.cancelled + " armed order(s)" : "no armed orders for this token") : j.error;
          if (j.ok) loadAutoSells();
        } catch (e) { status.textContent = e.message; }
      }

      // Pull trades made outside the app (Uniswap UI etc.) into the ledger,
      // then refresh P/L so the reconciled history shows up immediately.
      async function walletSync() {
        const token = document.getElementById("token").value.trim();
        const status = document.getElementById("plStatus");
        if (!/^0x[0-9a-fA-F]{40}$/.test(token)) { status.textContent = "enter a valid token address first"; return; }
        status.textContent = "syncing wallet history…";
        try {
          const r = await fetch("/api/sniper/wallet-sync", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ chain: ctx.chain, token }) });
          const j = await r.json();
          if (!j.ok) { status.textContent = j.error; return; }
          status.textContent = "synced — " + j.added + " external trade(s) imported" + (j.skipped ? ", " + j.skipped + " already known" : "");
          loadPL();
        } catch (e) { status.textContent = e.message; }
      }

      // Migrate this token to Accumulation: ensure a dormant dip_watcher exists,
      // then open the Set plan modal on /tokens for it (create-then-plan flow).
      async function accumulateToken() {
        const token = document.getElementById("token").value.trim();
        const status = document.getElementById("sellStatus");
        if (!/^0x[0-9a-fA-F]{40}$/.test(token)) { status.textContent = "enter a valid token address first"; return; }
        status.textContent = "migrating…";
        try {
          const r = await fetch("/api/sniper/migrate", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ chain: ctx.chain, token, symbol: lastDiscover?.symbol ?? null, pool: chosenPool }) });
          const j = await r.json();
          if (!j.ok) { status.textContent = j.error; return; }
          status.textContent = "tracked — opening plan…";
          location.href = "/tokens?plan=" + encodeURIComponent(j.watcherId);
        } catch (e) { status.textContent = e.message; }
      }

      async function loadAutoSells() {
        const el = document.getElementById("asOrders");
        const token = document.getElementById("token").value.trim().toLowerCase();
        try {
          const r = await fetch("/api/sniper/autosell/list", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ chain: ctx.chain }) });
          const j = await r.json();
          if (!j.ok) return;
          // Only this token's orders — stale rows from previous tokens were
          // cluttering the panel and looked like un-cancellable orders.
          const mine = token ? (j.orders || []).filter((o) => String(o.contract_address).toLowerCase() === token) : [];
          if (!mine.length) { el.innerHTML = '<p class="hint">No auto-sell orders for this token.</p>'; return; }
          el.innerHTML = mine.map((o) => {
            const pill = o.status === "armed" ? '<span class="pill on">armed</span>'
              : o.status === "triggered" ? '<span class="pill on" style="color:#4ade80;border-color:rgba(74,222,128,0.4)">triggered</span>'
              : '<span class="pill off" style="color:#f87171;border-color:rgba(248,113,113,0.3)">' + esc(o.status) + '</span>';
            return '<div class="approval-row" style="font-size:0.82rem"><div><div style="font-weight:600">+' + Number(o.target_pct) + '% target</div>' +
              '<div class="hint">cost ' + Number(o.cost_at_arm_eth).toFixed(4) + ' ETH' + (o.error ? " · " + esc(o.error).slice(0, 60) : "") + '</div></div>' + pill + '</div>';
          }).join("");
        } catch { /* non-fatal */ }
      }
      // ───────────────────────────────────────────────────────────────────────


      async function loadPL() {
        const token = document.getElementById("token").value.trim();
        const status = document.getElementById("plStatus");
        const note = document.getElementById("plNote");
        if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
          ["plBalance", "plNetCost", "plUnrealized"].forEach((id) => document.getElementById(id).textContent = "—");
          ["plValueUsd", "plBuysSells", "plUnrealizedEth"].forEach((id) => document.getElementById(id).textContent = "");
          note.style.display = "none";
          return;
        }
        status.textContent = "loading...";
        try {
          const r = await fetch("/api/sniper/pl", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ chain: ctx.chain, token }) });
          const j = await r.json();
          if (!j.ok) { status.textContent = j.error; return; }
          status.textContent = "";
          document.getElementById("plBalance").textContent = Number(j.balance) > 0 ? Number(j.balance).toLocaleString(undefined, { maximumFractionDigits: 4 }) + " " + (j.symbol || "tokens") : "0";
          document.getElementById("plValueUsd").textContent = j.valueUsd > 0 ? "≈ $" + Number(j.valueUsd).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "";
          document.getElementById("plBuysSells").textContent = j.buys + " buy" + (j.buys === 1 ? "" : "s") + " · " + j.sells + " sell" + (j.sells === 1 ? "" : "s")
            + (Number(j.boughtEth) > 0 ? " · paid " + Number(j.boughtEth).toLocaleString(undefined, { maximumFractionDigits: 4 }) + " ETH" : "")
            + (Number(j.soldEth) > 0 ? " · received " + Number(j.soldEth).toLocaleString(undefined, { maximumFractionDigits: 4 }) + " ETH" : "");
          // A NEGATIVE net cost means the sells already paid back more than the
          // buys cost — render that as "cost recovered" instead of a bare
          // negative (a closed round-trip makes net cost ≡ −realized, which
          // read like a bug: IF, 2026-09-14).
          const netEl = document.getElementById("plNetCost");
          const nc = Number(j.netCostEth);
          netEl.textContent = nc < 0
            ? "recovered (+ " + Math.abs(nc).toLocaleString(undefined, { maximumFractionDigits: 4 }) + " ETH)"
            : nc.toLocaleString(undefined, { maximumFractionDigits: 4 }) + " ETH";
          netEl.className = "pl-value " + plClass(-nc); // negative net cost = healthy
          const rl = Number(j.realizedEth ?? 0);
          const rlEl = document.getElementById("plRealized");
          rlEl.textContent = (rl > 0 ? "+" : "") + rl.toLocaleString(undefined, { maximumFractionDigits: 4 }) + " ETH";
          rlEl.className = "pl-value " + plClass(rl);
          document.getElementById("plRealizedEth").textContent = (j.ethUsd > 0 && rl !== 0 ? "≈ $" + (rl * j.ethUsd).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "");
          const urEl = document.getElementById("plUnrealized");
          if (Number(j.balance) <= 0) {
            // No held tokens → unrealized P/L is meaningless. Show neutral state.
            urEl.textContent = "—";
            urEl.className = "pl-value";
            document.getElementById("plUnrealizedEth").textContent = "no held tokens";
          } else if (j.unrealizedEth == null) {
            urEl.textContent = "quote unavailable";
            urEl.className = "pl-value";
            document.getElementById("plUnrealizedEth").textContent = "";
          } else {
            const ur = Number(j.unrealizedEth);
            urEl.textContent = (ur > 0 ? "+" : "") + ur.toLocaleString(undefined, { maximumFractionDigits: 4 }) + " ETH";
            urEl.className = "pl-value " + plClass(ur);
            let pct = "";
            if (j.netCostEth > 0) {
              pct = " (" + (ur / j.netCostEth * 100).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%)";
            }
            document.getElementById("plUnrealizedEth").textContent = (j.ethUsd > 0 && ur !== 0 ? "≈ $" + (ur * j.ethUsd).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "") + pct;
          }
          note.style.display = j.realizedUnknown ? "" : "none";
          if (j.realizedUnknown) note.textContent = "Some past sells have no recorded proceeds — realized cost basis may be understated until the next sell records them.";
        } catch (e) { status.textContent = e.message; }
      }

      // Approvals card removed (2026-09-19): buys pay native ETH (no ERC-20
      // approval involved) and the old card read the GLOBAL env signer's
      // allowances (a wallet belonging to nobody), plus a USDC row nothing
      // on this platform uses. Sells through the app set their own approvals
      // (Permit2 / exact router spends) server-side when a venue needs them.
      // The /api/sniper/approvals + /api/sniper/approve routes still exist
      // (unused) — remove them if nothing re-adopts the flow.

      async function sellNow() {
        const status = document.getElementById("sellStatus");
        const token = document.getElementById("token").value.trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(token)) { status.textContent = "invalid address"; return; }
        status.textContent = "selling...";
        try {
          const body = {
            chain: ctx.chain,
            token,
            sellPct: document.getElementById("sellPct").value,
            slippagePct: document.getElementById("slippage").value,
            maxGasGwei: document.getElementById("maxGas").value,
            pool: chosenPool || undefined,
          };
          const j = await window.directSignTrade("/api/sniper/sell", body, (m) => { status.textContent = m; });
          status.textContent = j.ok ? "sold — tx " + j.txHash.slice(0, 10) + "…" : j.error;
          if (j.ok) setTimeout(() => location.reload(), 1200);
        } catch (e) { status.textContent = e.message; }
      }

      // Prefill from query params (e.g. /sniper?token=0x... from the Alpha tab)
      let bootToken = null;
      try {
        const qp = new URLSearchParams(location.search), qt = qp.get("token");
        if (qt && /^0x[0-9a-fA-F]{40}$/.test(qt)) { document.getElementById("token").value = qt; bootToken = qt; }
      } catch {}

      renderCtx();
      loadAutoSells();
      // Boot: populate the datalist memory, but NEVER auto-fill or auto-run
      // discovery — the input reflects what the user types (or a URL param
      // when arriving from Alpha's Snipe links). A stale active token used to
      // refill itself on every refresh, which felt like a stuck UI.
      (async () => {
        await loadRecent(); // datalist only
        if (bootToken) { document.getElementById("token").value = bootToken; discover(); }
      })();
    </script>
  `, "sniper");
}
