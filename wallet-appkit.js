/**
 * wallet-appkit.js — AppKit-powered header Connect-wallet upgrade (Phase 2).
 *
 * Replaces window.ethereum-only connect with the Reown universal modal:
 * injected wallets, WalletConnect QR, EIP-6963 discovery, 300+ wallets.
 *
 * Exports APPKIT_SCRIPT(projectId, rpcUrl) — a module script that initializes
 * AppKit and exposes window.appKitModal + window.appKitConnect() returning the
 * EIP-1193 provider + address. wallet-connect.js's wcToggleConnect uses
 * window.appKitConnect when available, falling back to window.ethereum.
 */

export const APPKIT_VERSION = "1.8.24";

export function APPKIT_SCRIPT(projectId, rpcUrl) {
  return `<script type="module">
  import { createAppKit } from 'https://esm.sh/@reown/appkit@${APPKIT_VERSION}';
  import { EthersAdapter } from 'https://esm.sh/@reown/appkit-adapter-ethers@${APPKIT_VERSION}';

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

  window.appKitModal = modal;

  window.appKitConnect = async function appKitConnect() {
    modal.open();
    // Check current state first (pre-connected wallets don't re-fire the state subscription)
    const getAddr = () => modal.getAddress?.() || modal.getState?.()?.address;
    const address = await new Promise((resolve, reject) => {
      const immediate = getAddr();
      if (immediate) { resolve(immediate); return; }
      const timeout = setTimeout(() => reject(new Error('No wallet connected within 120s')), 120000);
      const unsub = modal.subscribeState((state) => {
        if (state.address) { unsub(); clearTimeout(timeout); resolve(state.address); }
      });
    });
    const provider = modal.getWalletProvider?.();
    return { address, provider };
  };
</script>`;
}
