/**
 * copilot-ui.js — header badge + approval panel + SSE client for co-pilot mode.
 * Ships COPILOT_BADGE (header markup) and COPILOT_JS (inline script, zero deps),
 * mirroring wallet-connect.js's export style.
 *
 * Flow: the server's engines enqueue sign requests while in co-pilot mode.
 * This script receives them over SSE (or via the page-load pending restore)
 * and shows a PULSING ⏳ BADGE — no auto-popup (2026-09-22). Clicking the
 * badge opens the sign panel with a decoded summary; Approve sends the tx via
 * the browser wallet (window.ethereum), posting the hash back to
 * /api/copilot/resolve. Decline (or the server's own timeout) rejects the
 * engine's await — the trade is skipped and logged, never executed unsigned.
 */

export const COPILOT_BADGE = `
<span id="copilotArea" style="display:none">
  <button id="copilotBadge" class="wallet-connect-btn copilot-badge" onclick="cpOpenQueue()" title="Co-pilot: trades waiting for your approval">⏳ 0</button>
</span>
<style>
.copilot-badge { background:rgba(232,182,97,0.15); border-color:rgba(232,182,97,0.5); color:#e8b661; }
.copilot-badge.has-pending { animation: copilotPulse 1.2s ease-in-out infinite; }
@keyframes copilotPulse { 0%,100% { opacity:1 } 50% { opacity:0.55 } }
/* Native <dialog> (2026-09-20): renders in the browser's TOP LAYER, above
   any z-index, so it stacks above the exit <dialog> on /tokens.
   Placement (2026-09-22): anchored TOP-RIGHT under the header, next to
   where the ⏳ badge lives — it used to render bottom-left (fallback path
   without flex centering), visually disconnected from the badge that
   opened it. */
dialog#cpModalBackdrop { background:transparent; border:none; padding:0; max-width:none; width:auto; height:auto; display:none; align-items:flex-start; justify-content:flex-end; padding:3.6rem 1rem 0 0; }
dialog#cpModalBackdrop[open] { display:flex; }
dialog#cpModalBackdrop::backdrop { background:rgba(0,0,0,0.45); }
#cpModal { background:#16181d; border:1px solid rgba(232,182,97,0.4); border-radius:10px; max-width:460px; width:92%; padding:1.2rem 1.3rem; color:#fafafa; font-size:0.9rem; }
#cpModal h3 { margin:0 0 0.5rem; font-size:1rem; color:#e8b661; }
#cpModal .cp-row { display:flex; justify-content:space-between; gap:0.8rem; padding:0.3rem 0; border-bottom:1px solid rgba(255,255,255,0.06); }
#cpModal .cp-row span:first-child { color:#9aa0a6; }
#cpModal .cp-summary { margin:0.7rem 0; padding:0.6rem; background:rgba(255,255,255,0.04); border-radius:6px; font-size:0.82rem; line-height:1.45; word-break:break-word; }
#cpModal .cp-actions { display:flex; gap:0.6rem; margin-top:0.9rem; }
#cpModal button { flex:1; padding:0.55rem 0; border-radius:6px; border:none; cursor:pointer; font-weight:600; }
#cpApprove { background:#4ade80; color:#0b1f14; }
#cpApprove:disabled { background:#3a5c46; color:#9aa0a6; cursor:wait; }
#cpDecline { background:rgba(248,113,113,0.12); color:#f87171; border:1px solid rgba(248,113,113,0.4) !important; }
#cpCountdown { font-size:0.75rem; color:#9aa0a6; text-align:center; margin-top:0.5rem; }
</style>`;

export const COPILOT_JS = /* js */`
// ── Co-pilot: SSE sign-request listener + approval modal ────────────────────
var _cpQueue = [], _cpCurrent = null, _cpTimer = null, _cpSse = null, _cpBusy = false;

function _cpE(s) { var d = {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}; return String(s == null ? '' : s).replace(/[<>&"]/g, function(c){ return d[c]; }); }

// chainId hex for the sign request's chain (mirrors wallet-slideout's helper).
function chainIdHexForCp(chain) {
  return chain === 'base' ? '0x2105' : (chain === 'robinhood' ? '0x1237' : '0x1');
}

function cpInit() {
  fetch('/api/copilot/pending').then(function(r){ return r.json(); }).then(function(j) {
    var area = document.getElementById('copilotArea');
    // Badge shows when requests exist for me, even if the global env flag is
    // off (per-user mode governs; the env flag alone once hid live requests).
    var hasPending = j.ok && j.requests && j.requests.length > 0;
    if (area) area.style.display = (j.ok && (j.active || hasPending)) ? 'inline' : 'none';
    if (hasPending) {
      // Restored session: adopt pending requests (dedupe by id). NO
      // auto-popup (2026-09-22): the user decides when to review — the
      // pulsing ⏳ badge is the notification; clicking it opens the panel.
      _cpQueue = j.requests.filter(function(r){ return !_cpCurrent || r.id !== _cpCurrent.id; });
      cpUpdateBadge();
    }
  }).catch(function(){});
  cpConnectSse();
}

function cpConnectSse() {
  if (_cpSse) return;
  try {
    _cpSse = new EventSource('/api/copilot/stream');
    _cpSse.addEventListener('request', function(ev) {
      try {
        var req = JSON.parse(ev.data);
        if (_cpCurrent && req.id === _cpCurrent.id) return;
        if (_cpQueue.some(function(r){ return r.id === req.id; })) return;
        _cpQueue.push(req);
        cpUpdateBadge();
        // NO auto-popup (2026-09-22): the SSE push only queues + updates the
        // badge + toasts. The badge pulse is the notification; clicking it
        // opens the sign panel (cpOpenQueue). A popup that appears out of
        // nowhere while you're mid-task on another tab is hostile UX.
        var lbl = { buy:'Buy', sell:'Sell', approve:'Token approval', wrap:'Wrap ETH', other:'Call' }[req.kind] || req.kind;
        var sym = req.symbol ? ' · ' + req.symbol : '';
        cpToast('⏳ Co-pilot: ' + lbl + sym + ' awaiting your approval — click the ⏳ badge (top right)');
      } catch (e) {}
    });
    _cpSse.addEventListener('resolved', function(ev) {
      try {
        var j = JSON.parse(ev.data);
        if (_cpCurrent && j.id === _cpCurrent.id) {
          // Server-side expiry/decline while modal open
          if (j.status && j.status !== 'approved') cpCloseModal(j.status);
          _cpCurrent = null; _cpQueue = _cpQueue.filter(function(r){ return r.id !== j.id; });
          cpUpdateBadge(); cpShowNext();
        } else {
          _cpQueue = _cpQueue.filter(function(r){ return r.id !== j.id; });
          cpUpdateBadge();
        }
      } catch (e) {}
    });
  } catch (e) { _cpSse = null; }
}

function cpUpdateBadge() {
  var b = document.getElementById('copilotBadge');
  if (!b) return;
  var n = _cpQueue.length + (_cpCurrent ? 1 : 0);
  b.textContent = '\\u23F3 ' + n;
  b.classList.toggle('has-pending', n > 0);
  b.title = n ? n + ' trade(s) waiting for your approval — click to review' : 'No trades awaiting approval';
}

function cpOpenQueue() { cpShowNext(true); }

function cpShowNext(force) {
  if (_cpCurrent && !force) return;
  if (_cpCurrent && !force) return;
  if (_cpCurrent) return; // one modal at a time; resolved/expired closes it
  var req = _cpQueue.shift();
  _cpQueue = _cpQueue.filter(function(r){ return r.id !== (req && req.id); });
  if (!req) { cpUpdateBadge(); return; }
  _cpCurrent = req;
  cpRenderModal(req);
}

function cpRenderModal(req) {
  var bd = document.getElementById('cpModalBackdrop');
  if (!bd) return;
  var kindLabel = { buy:'BUY', sell:'SELL', approve:'TOKEN APPROVAL', wrap:'WRAP ETH', other:'CALL' }[req.kind] || req.kind.toUpperCase();
  var productLabel = { dip:'Accumulate', sniper:'Sniper', mm:'Market Maker', other:'App' }[req.product] || req.product;
  var eth = req.value && req.value !== '0' ? (Number(req.value) / 1e18) : 0;
  // showModal (2026-09-20): top-layer stacking above the exit <dialog>. A
  // dialog already open with showModal() cannot be re-shown — close it first.
  try { if (bd.open) bd.close(); } catch {}
  try { bd.showModal(); } catch (e) { bd.style.display = 'flex'; } // fallback if dialog unsupported
  document.getElementById('cpModal').innerHTML =
    '<h3>' + kindLabel + ' — ' + _cpE(productLabel) + (_cpE(req.symbol) ? ' · ' + _cpE(req.symbol) : '') + '</h3>' +
    '<div class="cp-row"><span>Network</span><span>' + _cpE(req.chainName || req.chain) + '</span></div>' +
    '<div class="cp-row"><span>Send</span><span>' + (eth ? eth.toFixed(6) + ' ETH' : '0 ETH (no value)') + '</span></div>' +
    '<div class="cp-row"><span>Contract</span><span style="font-family:monospace;font-size:0.75rem">' + _cpE(req.to) + '</span></div>' +
    '<div class="cp-summary">' + _cpE(req.summary || 'Raw calldata — review carefully before approving.') + '</div>' +
    '<div class="cp-actions">' +
      '<button id="cpApprove" onclick="cpApprove()">Approve &amp; sign</button>' +
      '<button id="cpDecline" onclick="cpDecline()">Decline</button>' +
    '</div>' +
    '<div id="cpCountdown"></div>';
  cpStartCountdown(req.expiresAt);
}

function cpStartCountdown(expiresAt) {
  clearInterval(_cpTimer);
  var el = document.getElementById('cpCountdown');
  function tick() {
    if (!_cpCurrent) return clearInterval(_cpTimer);
    var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    if (el) el.textContent = left > 0 ? 'Expires in ' + left + 's — if it expires, the trade is SKIPPED and logged' : 'Expired — closing\\u2026';
    if (left <= 0) { clearInterval(_cpTimer); setTimeout(function(){ if (_cpCurrent) cpCloseModal(); }, 1200); }
  }
  tick();
  _cpTimer = setInterval(tick, 1000);
}

function cpCloseModal() {
  clearInterval(_cpTimer); _cpTimer = null; _cpCurrent = null;
  var bd = document.getElementById('cpModalBackdrop');
  if (bd) { try { bd.close(); } catch {} bd.style.display = 'none'; }
  cpUpdateBadge(); cpShowNext();
}

function cpCloseModalWithStatus(status) {
  clearInterval(_cpTimer); _cpTimer = null; _cpCurrent = null;
  var bd = document.getElementById('cpModalBackdrop');
  if (bd) { try { bd.close(); } catch {} bd.style.display = 'none'; }
  cpUpdateBadge(); cpShowNext();
  if (status) cpToast('Trade ' + status + ' — nothing signed');
}

async function cpApprove() {
  var req = _cpCurrent;
  if (!req || _cpBusy) return;
  if (!window.ethereum) { alert('No browser wallet found — install MetaMask/Rabby or decline this request.'); return; }
  if (!req.to || !/^0x[0-9a-fA-F]{40}$/.test(req.to)) { cpToast('Malformed sign request (missing contract) — decline it and retry the trade'); cpDecline(); return; }
  _cpBusy = true;
  var btn = document.getElementById('cpApprove');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing\\u2026'; }
  try {
    var accts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    var from = accts && accts[0];
    if (!from) { cpToast('No active account in your wallet'); return; }
    var tx = { from: from, to: req.to, data: req.data || '0x', value: '0x' + BigInt(req.value || '0').toString(16), chainId: chainIdHexForCp(req.chain) };
    var txHash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
    var r = await fetch('/api/copilot/resolve', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: req.id, txHash: txHash }) });
    var j = await r.json();
    if (!j.ok) cpToast('Server rejected the hash: ' + (j.error || 'unknown'));
    cpCloseModalWithStatus(null);
  } catch (e) {
    if (e && e.code === 4001) { cpToast('Signature rejected in wallet — request stays pending until you Decline or it expires'); }
    else { cpToast('Wallet error: ' + (e.message || e)); }
  } finally {
    _cpBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Approve & sign'; }
  }
}

async function cpDecline() {
  var req = _cpCurrent;
  if (!req) return;
  try { await fetch('/api/copilot/decline', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: req.id }) }); } catch (e) {}
  cpCloseModalWithStatus('declined');
}

// Toast helper (shared fallback if the app defines none)
function cpToast(msg) {
  var t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:1.2rem;left:50%;transform:translateX(-50%);background:#16181d;border:1px solid rgba(232,182,97,0.4);color:#fafafa;padding:0.6rem 1rem;border-radius:8px;font-size:0.82rem;z-index:9999;max-width:80vw';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 5000);
}

// Request Notification permission once when co-pilot is active (best effort).
if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
  fetch('/api/copilot/pending').then(function(r){ return r.json(); }).then(function(j) {
    if (j.ok && j.active) Notification.requestPermission().catch(function(){});
  }).catch(function(){});
}

cpInit();
`;
