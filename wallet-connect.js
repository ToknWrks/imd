/**
 * wallet-connect.js — header "Connect wallet" button = the ENTIRE sign-in
 * flow (2026-09-19). There is no separate login page/gate anymore: clicking
 * this button connects a wallet (window.ethereum, or the Reown AppKit modal
 * when window.appKitConnect is available) and immediately signs the login
 * nonce with it. A successful signature both proves ownership AND becomes
 * the session — identity = wallet address (auth.mjs).
 *
 * This file ships BOTH:
 *   - WALLET_CONNECT_BUTTON: header button markup (shows address when signed in)
 *   - WALLET_CONNECT_JS: inline script (EIP-1193 — window.ethereum, zero deps)
 *
 * The key never leaves the browser extension; only the ADDRESS + a SIGNATURE
 * of a one-time server nonce are ever sent to the server.
 */
export const WALLET_CONNECT_BUTTON = `
<span id="walletConnectArea">
  <button id="walletConnectBtn" class="wallet-connect-btn" onclick="wcToggleConnect()" title="Connect your wallet and sign in">Connect wallet</button>
</span>`;

export const WALLET_CONNECT_JS = /* js */`
// ── Header wallet-connect = sign-in (EIP-1193, no dependencies) ────────────
var _wcAddress = null;

function _wcBtnLabel() {
  var b = document.getElementById('walletConnectBtn');
  if (!b) return;
  b.textContent = _wcAddress ? _wcAddress.slice(0, 6) + '\\u2026' + _wcAddress.slice(-4) : 'Connect wallet';
  b.classList.toggle('connected', Boolean(_wcAddress));
  b.title = _wcAddress ? 'Signed in — click to sign out' : 'Connect your wallet and sign in';
}

async function wcToggleConnect() {
  if (_wcAddress) return wcDisconnect();
  var btn = document.getElementById('walletConnectBtn');
  var origLabel = btn ? btn.textContent : '';
  try {
    var address, provider;
    // Prefer the Reown AppKit universal modal (any wallet — injected,
    // WalletConnect QR, 300+) when the platform script has initialized it.
    if (window.appKitConnect) {
      var res = await window.appKitConnect();
      if (!res || !res.address) return;
      address = res.address;
      provider = res.provider;
    } else if (window.ethereum) {
      var accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts || !accounts.length) return;
      address = accounts[0];
      provider = window.ethereum;
    } else {
      alert('No browser wallet found. Install MetaMask, Rabby, or another EIP-1193 wallet.');
      return;
    }
    if (!provider || !provider.request) throw new Error('wallet provider unavailable — try an injected wallet');

    if (btn) { btn.disabled = true; btn.textContent = 'Waiting for signature\\u2026'; }
    var nres = await fetch('/api/auth/nonce');
    var nj = await nres.json();
    if (!nj.ok) throw new Error(nj.error || 'nonce failed');

    // Guard against a half-torn-down provider whose personal_sign never
    // settles (the "infinite spin" lesson) — surface a retry instead of
    // hanging until the wallet's own timeout, if any.
    var signature = await Promise.race([
      provider.request({ method: 'personal_sign', params: [nj.message, address] }),
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('signature request stalled — click Connect wallet again')); }, 45000);
      }),
    ]);

    if (btn) btn.textContent = 'Verifying\\u2026';
    var vres = await fetch('/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address, signature: signature, nonce: nj.nonce }),
    });
    var vj = await vres.json();
    if (!vj.ok) throw new Error(vj.error || 'verification failed');
    location.reload();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = origLabel || 'Connect wallet'; }
    if (e && e.code === 4001) return; // user rejected in wallet
    alert('Sign-in failed: ' + (e.message || e));
  }
}

async function wcDisconnect() {
  _wcAddress = null;
  _wcBtnLabel();
  // FULL LOGOUT: signing out must end the server SESSION — the auth gate
  // means no session = every page shows the connect prompt.
  try { await fetch('/auth/logout', { method: 'POST' }); } catch {}
  try { if (window.appKitModal?.disconnect) await window.appKitModal.disconnect(); } catch {}
  try { localStorage.removeItem('@appkit/connection'); localStorage.removeItem('@w3m/connected'); localStorage.removeItem('wagmi.connected'); localStorage.removeItem('wagmi.wallet'); } catch {}
  location.href = '/';
}

// Restore the header label from the current session (never a shared/global
// value — this is the caller's OWN authenticated identity, from the cookie).
(async function wcRestore() {
  try {
    var r = await fetch('/api/session');
    var j = await r.json();
    if (j.ok && j.address) { _wcAddress = j.address; _wcBtnLabel(); }
  } catch {}
  if (window.ethereum && _wcAddress) {
    // If the wallet disconnects/switches accounts client-side, end the
    // session too rather than silently keep showing stale balances.
    window.ethereum.on && window.ethereum.on('accountsChanged', function (accs) {
      var next = (accs && accs[0]) || null;
      if (!next || next.toLowerCase() !== (_wcAddress || '').toLowerCase()) wcDisconnect();
    });
  }
})();
`;
