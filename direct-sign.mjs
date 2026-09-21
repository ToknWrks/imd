/**
 * direct-sign.mjs — browser-side direct-sign bridge for manual trades.
 *
 * 2026-09-21 UX decision (user): the co-pilot approval modal is for UNATTENDED
 * engine trades only. When the USER clicks a trade button themselves (exit on
 * the watcher, sell/buy on the sniper), their click IS the approval — routing
 * it through the modal + SSE + approval ledger was pure friction, and the
 * wallet-notification-then-click flow burned gas and time.
 *
 * Flow: the server builds the tx (to/data/value/chainId) and returns it in the
 * API response. The page hands it straight to window.ethereum (Rabby pops).
 * On success the hash is posted to /api/copilot/record so the trade still
 * lands in the ledger with its owner. No copilot_requests row, no modal.
 *
 * Toast notifications still fire for engine-initiated trades (those keep the
 * modal) — this module only handles the USER-initiated direct path.
 */
export const DIRECT_SIGN_JS = /* js */`
// Direct-sign: server returns { directSign: { to, data, value, chainId } } —
// the browser signs it immediately. No approval modal, no ledger round-trip.
window.directSignTx = async function(ds) {
  if (!window.ethereum) throw new Error('no browser wallet found');
  var accts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  var from = accts && accts[0];
  if (!from) throw new Error('no account active in your wallet');
  var tx = { from: from, to: ds.to, data: ds.data || '0x', value: '0x' + BigInt(ds.value || '0').toString(16), chainId: ds.chainId };
  if (ds.gas) tx.gas = ds.gas;
  return await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
};
// Toast: bottom-center notification (shared with copilot's cpToast when present)
window.dsToast = function(msg, err) {
  if (window.cpToast) { cpToast(msg); return; }
  var t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:1.2rem;left:50%;transform:translateX(-50%);background:#16181d;border:1px solid ' + (err ? 'rgba(248,113,113,0.4)' : 'rgba(232,182,97,0.4)') + ';color:' + (err ? '#f87171' : '#fafafa') + ';padding:0.6rem 1rem;border-radius:8px;font-size:0.82rem;z-index:9999;max-width:80vw';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 5000);
};
// Shared wrapper for manual trades: POST to the route; if the response carries
// directSign, hand it to the wallet and post the hash back for the ledger.
window.directTrade = async function(route, body, opts) {
  opts = opts || {};
  var statusEl = opts.statusEl ? document.getElementById(opts.statusEl) : null;
  var set = function(m) { if (statusEl) statusEl.textContent = m; };
  set('preparing the trade…');
  try {
    var r = await fetch(route, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    var j = await r.json();
    if (!j.ok) throw new Error(j.error || 'trade failed');
    if (!j.directSign) return j; // server executed it (autonomy) — done
    set('signing in your wallet…');
    var txHash = await window.directSignTx(j.directSign);
    // ledger: record the user-signed tx
    await fetch('/api/direct-trade/record', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ kind: j.recordKind, ref: j.recordRef, txHash: txHash, chain: j.chain, asset: j.asset, amount: j.amount, symbol: j.symbol }) });
    set('\\u2713 sent — tx ' + (txHash || '').slice(0, 10) + '…');
    return { ok: true, txHash: txHash };
  } catch (e) {
    if (e && e.code === 4001) { set('rejected in wallet'); throw e; }
    set(String(e.message || e));
    throw e;
  }
};
`;
