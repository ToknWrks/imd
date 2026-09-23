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
// Poll for a receipt via the wallet's own provider — used to wait for an
// approve() leg to mine before re-requesting the next staged step (Permit2
// chains build one call at a time; the next call needs the prior one final).
window.waitForWalletReceipt = async function(txHash, timeoutMs) {
  timeoutMs = timeoutMs || 90000;
  var start = Date.now();
  while (Date.now() - start < timeoutMs) {
    var r = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
    if (r) return r;
    await new Promise(function(res) { setTimeout(res, 1500); });
  }
  throw new Error('approval tx did not confirm in time — check your wallet, then try again');
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
// Generic direct-sign trade runner: POSTs to the route; when the response
// carries an approval leg (Permit2/ERC-20 allowance chain), signs it, waits
// for it to mine, then re-POSTs the SAME body to get the next staged step —
// approve -> approve -> trade, one wallet signature per step (mirrors what
// the server's autonomy signer does automatically). Only the final trade tx
// gets posted to the ledger. Returns the route's json on any non-directSign
// response (errors, or an already-executed autonomy result) unchanged.
window.directSignTrade = async function(route, body, setStatus) {
  for (var step = 0; step < 5; step++) {
    var r = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var j = await r.json();
    if (!j.ok || !j.directSign) return j;
    if (j.permitTypedData) {
      // IMD→ETH beta (2026-09-23): stage 1 is a FREE EIP-712 signature (the
      // per-trade Permit2 permit) — not a transaction, no gas. Sign it here,
      // then re-POST the SAME body with the signature embedded; the server
      // builds the final execute() calldata around it and returns the tx.
      if (!window.ethereum) throw new Error('no browser wallet found');
      setStatus('signing the permit (free, no gas)…');
      var sig = await window.ethereum.request({ method: 'eth_signTypedData_v4', params: [window.ethereum.selectedAddress || (await window.ethereum.request({ method: 'eth_requestAccounts' }))[0], JSON.stringify(j.permitTypedData)] });
      setStatus('building the swap…');
      body.permitSignature = { sig: sig, deadline: j.permitTypedData.message.sigDeadline, expiration: j.permitTypedData.message.details.expiration, nonce: j.permitTypedData.message.details.nonce };
      continue;
    }
    if (j.directSign.isApproval) {
      setStatus('approving token spend (' + (step + 1) + ')…');
      var approveHash = await window.directSignTx(j.directSign);
      setStatus('waiting for approval to confirm…');
      await window.waitForWalletReceipt(approveHash);
      continue;
    }
    setStatus('signing in your wallet…');
    var txHash = await window.directSignTx(j.directSign);
    await fetch('/api/direct-trade/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: j.recordKind, ref: j.recordRef, txHash: txHash, chain: j.chain, amount: j.amount, symbol: j.symbol }) });
    return { ok: true, txHash: txHash, directSigned: true };
  }
  return { ok: false, error: 'too many steps — try again' };
};
`;
