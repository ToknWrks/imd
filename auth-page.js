/**
 * auth-page.js — Reown AppKit-powered login page for the auth gate.
 *
 * Full wallet modal: injected wallets (MetaMask/Rabby), WalletConnect QR for
 * mobile wallets, EIP-6963 multi-wallet discovery, 300+ wallets via Reown
 * Cloud — everything AppKit shows, not just window.ethereum.
 *
 * Ships AUTH_LOGIN_PAGE(projectId) → full HTML string for auth.mjs.
 * Requires an AppKit Cloud project id (cloud.reown.com) in APPKIT_PROJECT_ID.
 * Flow after connect: personal_sign the server's nonce message → POST
 * /api/auth/verify → cookie → redirect.
 */

export const APPKIT_VERSION = "1.7.14";

export function AUTH_LOGIN_PAGE(projectId) {
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
  <p class="hint">Connect any wallet — browser wallets, mobile via WalletConnect QR, or 300+ through Reown.<br>The signature proves ownership only; it never moves funds.</p>
  <button id="btn">Connect wallet &amp; sign in</button>
  <div class="err" id="err"></div>
</div>
<script type="module">
  import { createAppKit } from 'https://esm.sh/@reown/appkit@${APPKIT_VERSION}';
  import { EthersAdapter } from 'https://esm.sh/@reown/appkit-adapter-ethers@${APPKIT_VERSION}';

  const projectId = '${projectId}';
  const ethereumMainnet = {
    id: 1,
    name: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://eth-mainnet.g.alchemy.com/v2/${projectId}'] } },
    blockExplorers: { default: { url: 'https://etherscan.io' } },
  };
  // NOTE: projectId above doubles as an Alchemy key placeholder — the real
  // RPC URL is injected server-side (APPKIT_ETH_RPC_URL), see below.
  const modal = createAppKit({
    adapters: [new EthersAdapter()],
    networks: [ethereumMainnet],
    projectId,
    themeMode: 'dark',
    themeVariables: { '--w3m-accent': '#e8b661' },
    features: { analytics: false, email: false, socials: false },
  });

  const btn = document.getElementById('btn');
  const err = document.getElementById('err');

  btn.addEventListener('click', async () => {
    err.textContent = '';
    try {
      // FORCE ACCOUNT SELECTION (2026-09-19): AppKit caches its connection in
      // localStorage — a previously-used wallet silently re-connects and the
      // modal never shows the account picker, so users think they switched
      // wallets while the server session stayed on the old address (the
      // "always 0x851a" illusion). Disconnect any stale session first so the
      // modal always starts fresh and the wallet extension pops its picker.
      try { await modal.disconnect?.(); } catch {}
      try { if (window.ethereum && window.ethereum.request) { /* don't revoke extension perms; just clear AppKit's cache */ } } catch {}
      try { localStorage.removeItem('@appkit/connection'); localStorage.removeItem('@w3m/connected'); localStorage.removeItem('wagmi.connected'); localStorage.removeItem('wagmi.wallet'); } catch {}
      // AppKit modal: user picks any wallet (injected, WC QR, 6963, etc.)
      await modal.open();
      // Wait for a connected address (modal resolves on connect)
      const account = await new Promise((resolve, reject) => {
        const immediate = modal.getAddress?.();
        if (immediate) { resolve(immediate); return; }
        const unsub = modal.subscribeState((state) => {
          const a = state?.selectedNetworkId && state?.address;
          if (a) { unsub(); resolve(a); }
        });
        setTimeout(() => reject(new Error('No wallet connected within 120s')), 120000);
      });
      btn.textContent = 'Waiting for signature\\u2026';
      const nres = await fetch('/api/auth/nonce');
      const nj = await nres.json();
      if (!nj.ok) throw new Error(nj.error || 'nonce failed');
      // EIP-1193 provider from the AppKit universal provider:
      const provider = await modal.getWalletProvider?.() ?? window.ethereum;
      const signerAddress = modal.getAddress?.() ?? account;
      const signature = await provider.request({ method: 'personal_sign', params: [nj.message, signerAddressOf(provider, signerAddress = signerAddress)] });
      btn.textContent = 'Verifying\\u2026';
      const vres = await fetch('/api/auth/verify', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ address: signerAddress, signature, nonce: nj.nonce }) });
      const vj = await vres.json();
      if (!vj.ok) throw new Error(vj.error || 'verification failed');
      location.reload();
    } catch (e) {
      if (e && e.code === 4001) err.textContent = 'Signature rejected in wallet.';
      else err.textContent = e.message || String(e);
      btn.disabled = false; btn.textContent = 'Connect wallet & sign in';
    }
  });

  function signerAddressOf(provider, fallback) { return fallback; }
</script>
</body></html>`;
}
