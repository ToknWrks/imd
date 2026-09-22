/**
 * copilot-ui.js — header badge + direct-sign flow for co-pilot mode.
 * Ships COPILOT_BADGE (header markup) and COPILOT_JS (inline script, zero deps),
 * mirroring wallet-connect.js's export style.
 *
 * Flow (2026-09-22, modal removed): the server's engines enqueue sign requests.
 * The pulsing ⏳ badge is the notification. CLICKING THE BADGE SENDS THE TX
 * STRAIGHT TO THE WALLET (window.ethereum) — no intermediate panel, the
 * wallet IS the confirmation UI and shows to/value/calldata anyway.
 * A second click signs the next queued request. Wallet-reject leaves the
 * request pending until its expiry, then the trade is skipped and logged —
 * never executed unsigned.
 */

export const COPILOT_BADGE = `
<span id="copilotArea" style="display:none">
  <button id="copilotBadge" class="wallet-connect-btn copilot-badge" onclick="cpApprove()" title="Co-pilot: trades waiting for your approval — click to sign in your wallet">⏳ 0</button>
</span>
<style>
.copilot-badge { background:rgba(232,182,97,0.15); border-color:rgba(232,182,97,0.5); color:#e8b661; }
.copilot-badge.has-pending { animation: copilotPulse 1.2s ease-in-out infinite; }
@keyframes copilotPulse { 0%,100% { opacity:1 } 50% { opacity:0.55 } }
.copilot-badge.cp-busy { animation:none; opacity:0.6; cursor:wait; }
</style>`;

export const COPILOT_JS = /* js */`
// ── Co-pilot: SSE sign-request listener + direct-sign on badge click ─────────
var _cpQueue = [], _cpBusy = false, _cpSse = null;

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
      // Restored session: adopt pending requests (dedupe by id). No popup —
      // the badge IS the notification; clicking it signs.
      _cpQueue = j.requests;
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
        if (_cpQueue.some(function(r){ return r.id === req.id; })) return;
        _cpQueue.push(req);
        cpUpdateBadge();
        var lbl = { buy:'Buy', sell:'Sell', approve:'Token approval', wrap:'Wrap ETH', other:'Call' }[req.kind] || req.kind;
        var sym = req.symbol ? ' · ' + req.symbol : '';
        var msg = 'Co-pilot: ' + (req.summary || (lbl + sym)) + ' — click the ⏳ badge to sign';
        cpToast('⏳ ' + msg);
        cpNotify('⏳ Co-pilot sign request', msg);
        cpTitleMarker();
      } catch (e) {}
    });
    _cpSse.addEventListener('skipped', function(ev) {
      try {
        var j = JSON.parse(ev.data);
        _cpQueue = _cpQueue.filter(function(r){ return r.id !== j.id; });
        cpUpdateBadge();
        var sym = j.symbol ? ' · ' + j.symbol : '';
        var msg = (j.status === 'expired' ? 'expired unsigned' : 'declined') + ' — trade skipped and logged' + (j.error ? ' (' + j.error + ')' : '');
        cpToast('✗ ' + sym + ' ' + msg);
        cpNotify('✗ Co-pilot trade skipped', sym + ' ' + msg);
        cpTitleMarker();
      } catch (e) {}
    });
    _cpSse.addEventListener('resolved', function(ev) {
      try {
        var j = JSON.parse(ev.data);
        _cpQueue = _cpQueue.filter(function(r){ return r.id !== j.id; });
        cpUpdateBadge();
      } catch (e) {}
    });
  } catch (e) { _cpSse = null; }
}

/**
 * OS-level browser notification (2026-09-22): visible even when the app tab
 * is in the background or you're on another site — as long as any app tab
 * stays open. Permission is requested once at load when co-pilot is active;
 * silently degrades to the in-page toast when denied/unavailable.
 */
function cpNotify(title, body) {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      var n = new Notification(title, { body: body, tag: 'copilot-sign', silent: false });
      n.onclick = function(){ window.focus(); n.close(); };
    }
  } catch (e) {}
}

// Tab-title marker so an unfocused app tab with pending work is visible in
// the tab strip itself.
var _cpBaseTitle = null;
function cpTitleMarker() {
  if (_cpBaseTitle === null) _cpBaseTitle = document.title.replace(/^⏳ \d+ — /, '');
  var n = _cpQueue.length;
  document.title = n > 0 ? '⏳ ' + n + ' — ' + _cpBaseTitle : _cpBaseTitle;
}

function cpUpdateBadge() {
  var b = document.getElementById('copilotBadge');
  if (b) {
    var n = _cpQueue.length;
    b.textContent = '⏳ ' + n;
    b.classList.toggle('has-pending', n > 0);
    b.classList.toggle('cp-busy', _cpBusy);
    b.title = n ? n + ' trade(s) waiting — click to sign in your wallet' : 'No trades awaiting approval';
  }
  cpTitleMarker();
}

/**
 * THE badge click (2026-09-22, modal removed): pops the oldest pending
 * request and sends it straight to the browser wallet. No intermediate
 * panel — the wallet's own confirmation screen (which shows to/value/
 * calldata) IS the review step; a second in-app confirm before it added
 * nothing. Wallet-reject leaves the request pending (retry via another
 * badge click, or let it expire); each further click signs the next
 * queued request.
 */
async function cpApprove() {
  if (_cpBusy) return;
  var req = _cpQueue[0];
  if (!req) { cpToast('No trades awaiting approval'); return; }
  if (!window.ethereum) { alert('No browser wallet found — install MetaMask/Rabby to sign co-pilot trades.'); return; }
  if (!req.to || !/^0x[0-9a-fA-F]{40}$/.test(req.to)) { cpToast('Malformed sign request — it will be skipped at expiry'); _cpQueue.shift(); cpUpdateBadge(); return; }
  _cpBusy = true;
  cpUpdateBadge();
  // A user gesture is the best moment to ask for notification permission —
  // if the load-time prompt never ran (or was dismissed), catch up here so
  // the NEXT request can deliver an OS notification.
  try { if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(function(){}); } catch (e) {}
  try {
    var accts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    var from = accts && accts[0];
    if (!from) { cpToast('No active account in your wallet'); return; }
    var tx = { from: from, to: req.to, data: req.data || '0x', value: '0x' + BigInt(req.value || '0').toString(16), chainId: chainIdHexForCp(req.chain) };
    var txHash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
    var r = await fetch('/api/copilot/resolve', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: req.id, txHash: txHash }) });
    var j = await r.json();
    if (!j.ok) {
      // Keep the request queued — the engine is still polling the row and
      // settles the moment a resolve succeeds; surface why it bounced.
      cpToast('Hash not accepted: ' + (j.error || 'unknown') + ' — click ⏳ to retry');
    } else {
      _cpQueue.shift();
      var sym = req.symbol ? ' · ' + req.symbol : '';
      cpToast('✅ Signed' + sym + ' — tx ' + txHash.slice(0, 10) + '… recorded');
      if (_cpQueue.length) cpToast('⏳ ' + _cpQueue.length + ' more request(s) waiting — click the badge again');
    }
  } catch (e) {
    if (e && e.code === 4001) { cpToast('Rejected in wallet — request stays pending; click ⏳ to retry or let it expire'); }
    else { cpToast('Wallet error: ' + (e.message || e)); }
  } finally {
    _cpBusy = false;
    cpUpdateBadge();
  }
}

// Toast helper (shared fallback if the app defines none)
function cpToast(msg) {
  var t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:1.2rem;left:50%;transform:translateX(-50%);background:#16181d;border:1px solid rgba(232,182,97,0.4);color:#fafafa;padding:0.6rem 1rem;border-radius:8px;font-size:0.82rem;z-index:9999;max-width:80vw';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 5000);
}

// Request Notification permission (best effort). The old gate required the
// global COPILOT_ACTIVE env flag — always false in per-user mode on hosted —
// so the prompt NEVER appeared and users got no OS notifications (found live
// 2026-09-22). Prompt whenever this user has anything copilot-shaped: pending
// requests or the badge visible. Also retried inside cpApprove (a click is
// the strongest gesture — browsers favor permission requests from one).
if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
  fetch('/api/copilot/pending').then(function(r){ return r.json(); }).then(function(j) {
    var hasPending = j.ok && j.requests && j.requests.length > 0;
    if (j.ok && (j.active || hasPending)) Notification.requestPermission().catch(function(){});
  }).catch(function(){});
}

cpInit();
`;
