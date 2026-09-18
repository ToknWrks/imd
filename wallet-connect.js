/**
 * wallet-connect.js — header "Connect wallet" button + EIP-1193 browser-wallet
 * session. This is the host-deployment path to a fully in-browser ownership
 * model: the user connects MetaMask/Rabby/etc from the header, that address
 * becomes the app's owner/connected wallet, and the AA session key signs
 * trades server-side.
 *
 * This file ships BOTH:
 *   - WALLET_CONNECT_BUTTON: header button markup (shows address when connected)
 *   - WALLET_CONNECT_JS: inline script (EIP-1193 — window.ethereum, zero deps)
 *
 * The connected address is persisted server-side via /api/wallet-connect
 * (POST connect/disconnect) so the backend can resolve "the user's wallet"
 * for reads (balances, positions) without any key material — the KEY never
 * leaves the browser extension; only the ADDRESS is shared with the server.
 *
 * Migration note (2026-09-17): this is step 1 of removing VAULT_ACTIVE /
 * AGENT_PRIVATE_KEY as signer options. Phase order:
 *   1. Connect wallet (address only, read-only balances)      ← this file
 *   2. Fund SCW from the connected wallet (browser signs the transfer)
 *   3. Smart wallet (AA_SESSION_KEY) signs all app trades — server-side
 *   4. Owner signing moves fully client-side; server holds NO user key.
 */
export const WALLET_CONNECT_BUTTON = `
<span id="walletConnectArea">
  <button id="walletConnectBtn" class="wallet-connect-btn" onclick="wcToggleConnect()" title="Connect your wallet (address only — keys stay in your wallet)">Connect wallet</button>
</span>`;

export const WALLET_CONNECT_JS = /* js */`
// ── Header wallet-connect (EIP-1193, no dependencies) ──────────────────────
var _wcAddress = null;

function _wcBtnLabel() {
  var b = document.getElementById('walletConnectBtn');
  if (!b) return;
  b.textContent = _wcAddress ? _wcAddress.slice(0, 6) + '\\u2026' + _wcAddress.slice(-4) : 'Connect wallet';
  b.classList.toggle('connected', Boolean(_wcAddress));
  b.title = _wcAddress ? 'Connected — click to disconnect' : 'Connect your wallet (address only — keys never leave your wallet)';
}

async function wcToggleConnect() {
  if (_wcAddress) return wcDisconnect();
  // Phase 2: prefer the Reown AppKit universal modal (any wallet — injected,
  // WalletConnect QR, 300+) when the platform script has initialized it.
  if (window.appKitConnect) {
    try {
      var res = await window.appKitConnect();
      if (!res || !res.address) return;
      _wcAddress = res.address;
      _wcBtnLabel();
      await fetch('/api/wallet-connect', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ address: _wcAddress }) });
      openWallet();
      return;
    } catch (e) {
      if (e && e.code === 4001) return;
      // fall through to injected-only below
    }
  }
  if (!window.ethereum) { alert('No browser wallet found. Install MetaMask, Rabby, or another EIP-1193 wallet.'); return; }
  try {
    var accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts.length) return;
    _wcAddress = accounts[0];
    _wcBtnLabel();
    // Persist the address server-side (read-only context — no key material).
    await fetch('/api/wallet-connect', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ address: _wcAddress }) });
    openWallet();
  } catch (e) {
    if (e && e.code === 4001) return; // user rejected
    alert('Wallet connect failed: ' + (e.message || e));
  }
}

async function wcDisconnect() {
  _wcAddress = null;
  _wcBtnLabel();
  await fetch('/api/wallet-connect', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ address: null }) });
}

// Restore a prior connection on load (address only — never re-requests access).
(async function wcRestore() {
  try {
    var r = await fetch('/api/wallet-connect');
    var j = await r.json();
    if (j.ok && j.address) { _wcAddress = j.address; _wcBtnLabel(); }
  } catch {}
  if (window.ethereum && _wcAddress) {
    // If the wallet is still connected, keep the address in sync on account change.
    window.ethereum.on && window.ethereum.on('accountsChanged', function(accs) {
      _wcAddress = (accs && accs[0]) || null;
      _wcBtnLabel();
      if (!_wcAddress) wcDisconnect();
    });
  }
})();
`;
