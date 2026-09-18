/**
 * auth-appkit.js — Reown AppKit login page for the auth gate (Phase 2 hosted).
 *
 * Full wallet modal on the gate page: injected wallets (MetaMask/Rabby/etc.),
 * WalletConnect QR for mobile wallets, EIP-6963 multi-wallet discovery, 300+
 * wallets via Reown Cloud. Requires WALLET_CONNECT_PROJECT_ID (Reown Cloud).
 *
 * Exports:
 *   AUTH_LOGIN_PAGE(projectId, rpcUrl) — full HTML string for the gate page
 *
 * Flow: user clicks Connect → AppKit modal → wallet connected → the page
 * fetches /api/auth/nonce → personal_sign via the wallet's EIP-1193 provider
 * → POST /api/auth/verify → session cookie → reload.
 *
 * Served as a SEPARATE script (type=module) because AppKit is ESM-only; the
 * import map approach proved fragile — serving node_modules content via
 * Caddy + an import map pointing at /vendor/ keeps versions exact.
 */

export const APPKIT_VERSION = "1.8.24";

export function AUTH_LOGIN_PAGE(projectId, rpcUrl) {
  return `<!doctype html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accumulate — Sign in</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0d0f12; color:#fafafa; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .box { width:min(380px, 92vw); background:#16181d; border:1px solid rgba(232,182,97,0.35); border-radius:10px; padding:1.6rem; text-align:center; }
  h1 { font-size:1.15rem; margin:0 0 0.3rem; }
  h1 span { color:#e8b661; }
  p.hint { color:#9aa0a6; font-size:0.8rem; margin:0 0 1.1rem; line-height:1.5; }
  button { width:100%; padding:0.65rem; background:#e8b661; color:#16181d; font-weight:700;
           border:none; border-radius:6px; cursor:pointer; font-size:0.95rem; }
  button:disabled { opacity:0.5; cursor:wait; }
  .err { color:#f87171; font-size:0.82rem; margin-top:0.7rem; min-height:1.1rem; line-height:1.4; }
</style>
</head>
<body><div class="box">
  <h1>Accumulate<span>IMD</span></h1>
  <p class="hint">Connect any wallet — browser wallets, mobile via WalletConnect, or 300+ through Reown.<br>The signature proves ownership only; it never moves funds.</p>
  <button id="btn">Connect wallet &amp; sign in</button>
  <div class="err" id="err"></div>
</div>
<script type="module">
  import { createAppKit } from 'https://esm.sh/@reown/appkit@${APPKIT_VERSION}';
  import { EthersAdapter } from 'https://esm.sh/@reown/appkit-adapter-ethers@${APPKIT_VERSION}';

  const btn = document.getElementById('btn');
  const err = document.getElementById('err');

  const modal = createAppKit({
    adapters: [new EthersAdapter()],
    networks: [{
      id: 1,
      name: 'Ethereum',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['${rpcUrl}'] } },
      blockExplorers: { default: { url: 'https://etherscan.io' } },
    }],
    projectId: '${projectId}',
    themeMode: 'dark',
    themeVariables: { '--w3m-accent': '#e8b661' },
    features: { analytics: false },
  });

  btn.addEventListener('click', async () => {
    err.textContent = '';
    try {
      btn.disabled = true;
      // Open the AppKit universal modal — user picks ANY wallet.
      modal.open();

      // Wait for connection. Check the CURRENT state FIRST (a wallet may
      // already be connected from a previous session — subscribeState only
      // fires on CHANGE, so a pre-connected wallet would hang the wait).
      const getAddress = () => modal.getAddress?.() || modal.getState?.()?.address;
      const address = await new Promise((resolve, reject) => {
        const immediate = getAddress();
        if (immediate) { resolve(immediate); return; }
        const timeout = setTimeout(() => reject(new Error('No wallet connected within 120s — try again')), 120000);
        const unsub = modal.subscribeState((state) => {
          if (state.address) { unsub(); clearTimeout(timeout); resolve(state.address); }
        });
      });
      btn.textContent = 'Waiting for signature…';

      // Fetch the login message + nonce from our server
      const nres = await fetch('/api/auth/nonce');
      const nj = await nres.json();
      if (!nj.ok) throw new Error(nj.error || 'nonce failed');

      // Sign via the wallet's EIP-1193 provider (AppKit exposes it directly)
      const provider = modal.getWalletProvider?.();
      if (!provider?.request) throw new Error('wallet provider unavailable — try an injected wallet');
      const signature = await provider.request({ method: 'personal_sign', params: [nj.message, address] });

      btn.textContent = 'Verifying…';
      const vres = await fetch('/api/auth/verify', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ address, signature, nonce: nj.nonce }) });
      const vj = await vres.json();
      if (!vj.ok) throw new Error(vj.error || 'verification failed');
      location.reload();
    } catch (e) {
      if (e && e.code === 4001) err.textContent = 'Signature rejected in wallet.';
      else err.textContent = e.message || String(e);
      btn.disabled = false; btn.textContent = 'Connect wallet & sign in';
    }
  });
</script>
</body></html>`;
}
