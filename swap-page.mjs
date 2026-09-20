/**
 * swap-page.mjs — /swap page markup. Embeds the SwapKit widget (CDN module
 * script + <swapkit-widget> custom element); all swap logic/UX is SwapKit's.
 * API key comes from SWAPKIT_API_KEY in .env (loaded by dashboard.mjs), with
 * the issued key as fallback. Follows the verify-page.mjs convention.
 */

const FALLBACK_API_KEY = "7887bc9f-5dc4-4c85-9d00-72d6ac8f74a6";
const WALLETS = "BITGET,BRAVE,COINBASE_WEB,CTRL,KEEPKEY_BEX,KEPLR,LEAP,METAMASK,OKX,ONEKEY,PHANTOM,TALISMAN,KEEPKEY,LEDGER,TREZOR,COINBASE_MOBILE,OKX_MOBILE,TRONLINK,VULTISIG,KEYSTORE";

export function swapPage({ shell }) {
  const apiKey = process.env.SWAPKIT_API_KEY?.trim() || FALLBACK_API_KEY;
  return shell("Swap", `
    <div class="card">
      <h2>Swap</h2>
      <p class="hint">Cross-chain swaps powered by SwapKit. Connect a wallet in the widget below.</p>
      <!-- SwapKit Widget -->
      <script type="module" src="https://cdn.swapkit.dev/widget/latest/swapkit-widget.js"><\/script>
      <swapkit-widget
        api-key="${apiKey}"
        wallets="${WALLETS}"
        input-asset="BTC.BTC"
        output-asset="ETH.ETH"
      ></swapkit-widget>
    </div>
  `, "swap");
}
