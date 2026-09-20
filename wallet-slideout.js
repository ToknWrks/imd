/**
 * wallet-slideout.js — slideout overlay HTML + inline JS.
 * Returns a string of HTML (overlay div + script tag) to embed in every page.
 */

/**
 * Pure helper: build eth_sendTransaction params for a browser-signed Fund /
 * Move-in tx. Exported for tests. `from` MUST be the extension's ACTIVE
 * account (eth_requestAccounts), never a page-load-cached address — the
 * "from should be same as current address" bug (2026-09-19) came from signing
 * with a stale identity after the user switched accounts in the extension.
 */
export function fundingTxParams({ from, scwAddress, asset, amount, chain, tokenAddress, tokenDecimals }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(from || "")) throw new Error("invalid from address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(scwAddress || "")) throw new Error("invalid smart-wallet address");
  const chainIdHex = chain === "base" ? "0x2105" : (chain === "robinhood" ? "0x1237" : "0x1");
  if (asset === "eth") {
    return { from, to: scwAddress, value: "0x" + BigInt(Math.round(amount * 1e18)).toString(16), chainId: chainIdHex };
  }
  // ERC-20 transfer(address,uint256) — selector a9059cbb
  const dec = tokenDecimals != null ? tokenDecimals : 6;
  const raw = BigInt(Math.round(amount * (10 ** dec))).toString(16).padStart(64, "0");
  const toPadded = scwAddress.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress || "")) throw new Error("no token configured for this asset");
  return { from, to: tokenAddress, data: "0xa9059cbb" + toPadded + raw, chainId: chainIdHex };
}

export const WALLET_NAV_BUTTON = `<button class="wallet-nav-btn" onclick="openWallet()" title="Wallet"
  style="display:flex;align-items:center;justify-content:center;width:36px;height:36px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:#fafafa;cursor:pointer;padding:0;">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21 7.28V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2.28A2 2 0 0 0 22 15V9a2 2 0 0 0-1-1.72zM20 9v6h-7V9h7zM5 19V5h14v2h-5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h5v2H5z"/></svg>
</button>`;

// JS helpers embedded in the slideout script
const SLIDEOUT_JS = /* js */`
// fundingTxParams — browser-side copy. The module-level export above is NOT in
// scope inside this embedded <script> block; keep the two implementations in
// sync (wallet-funding.test.mjs exercises the module export; the parse test
// covers this copy).
function fundingTxParams(params) {
  var from = params.from, scwAddress = params.scwAddress, asset = params.asset,
      amount = params.amount, chain = params.chain,
      tokenAddress = params.tokenAddress, tokenDecimals = params.tokenDecimals;
  if (!/^0x[0-9a-fA-F]{40}$/.test(from || "")) throw new Error("invalid from address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(scwAddress || "")) throw new Error("invalid smart-wallet address");
  var chainIdHex = chain === "base" ? "0x2105" : (chain === "robinhood" ? "0x1237" : "0x1");
  if (asset === "eth") {
    return { from: from, to: scwAddress, value: "0x" + BigInt(Math.round(amount * 1e18)).toString(16), chainId: chainIdHex };
  }
  var dec = tokenDecimals != null ? tokenDecimals : 6;
  var raw = BigInt(Math.round(amount * (10 ** dec))).toString(16).padStart(64, "0");
  var toPadded = scwAddress.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress || "")) throw new Error("no token configured for this asset");
  return { from: from, to: tokenAddress, data: "0xa9059cbb" + toPadded + raw, chainId: chainIdHex };
}

function _wf(n) { return n == null ? '\u2014' : Number(n).toLocaleString(void 0, {maximumFractionDigits:4}); }
function _wfu(n) { return n == null ? '\u2014' : Number(n).toLocaleString(void 0, {maximumFractionDigits:2}); }
function _we(s) { var d={'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}; return String(s||'').replace(/[<>&"]/g,function(c){return d[c];}); }
function _toggleAccordion(el) { el.parentElement.classList.toggle('open'); }

async function openWallet() {
  var o=document.getElementById('walletOverlay'), c=document.getElementById('walletContent');
  o.classList.add('open'); c.innerHTML='<div class="wallet-loading">Loading\u2026</div>';
  try {
    var r=await fetch('/api/wallet'), j=await r.json();
    if(!j.ok){c.innerHTML='<div class="wallet-loading">'+_we(j.error||'unavailable')+'</div>';return;}
    var h='';
    h+='<div class="wallet-accordion open">'+
      '<div class="wallet-accordion-header" onclick="_toggleAccordion(this)">'+
      '<span class="wallet-token-icon" style="background:#627eea;color:#fff">&Xi;</span>'+
      '<span>ETH</span>'+
      '<span class="arrow" style="margin-left:auto">\u25b6</span>'+
      '<span class="amount">'+_wf(j.eth.total)+' ETH</span>'+
      '<span class="usd">$'+_wfu(j.eth.totalUsd)+'</span>'+
      '</div><div class="wallet-accordion-body">';
    // Per-chain rows filtered to ETHEREUM (2026-09-19): robinhood + base
    // rows removed from the wallet UI — the platform is mainnet-only, and
    // the legacy chains' balances were zero-row noise. The API still returns
    // them; this is display filtering only.
    j.eth.chains.filter(function(c){return c.name==='Ethereum';}).forEach(function(c){
      h+='<div class="wallet-chain-row">'+
        '<span class="chain-icon" style="background:'+c.color+';color:#fff">'+c.initials+'</span>'+
        '<span>'+c.name+(c.error?' <span style="color:#f87171;font-size:0.7rem">\u26a0</span>':'')+'</span>'+
        '<span class="amount">'+_wf(c.balance)+' ETH</span>'+
        '<span class="usd">$'+_wfu(c.balanceUsd)+'</span>'+
        '</div>';
    });
    h+='</div></div>';
    // IMD accordion — the platform token (launchpad currency). Null when the
    // API has no IMD row (e.g. no token configured).
    if (j.imd) {
      h+='<div class="wallet-accordion">'+
        '<div class="wallet-accordion-header" onclick="_toggleAccordion(this)">'+
        '<span class="wallet-token-icon" style="background:#e8b661;color:#0b0d10">IMD</span>'+
        '<span>IMD</span>'+
        '<span class="arrow" style="margin-left:auto">\u25b6</span>'+
        '<span class="amount">'+_wf(j.imd.total)+' IMD</span>'+
        '<span class="usd">$'+_wfu(j.imd.totalUsd)+'</span>'+
        '</div><div class="wallet-accordion-body">';
      j.imd.chains.filter(function(c){return c.name==='Ethereum';}).forEach(function(c){
        h+='<div class="wallet-chain-row">'+
          '<span class="chain-icon" style="background:'+c.color+';color:#fff">'+c.initials+'</span>'+
          '<span>'+c.name+(c.error?' <span style="color:#f87171;font-size:0.7rem">\u26a0</span>':'')+'</span>'+
          '<span class="amount">'+_wf(c.balance)+' '+_we(c.symbol)+'</span>'+
          '</div>';
      });
      h+='</div></div>';
    }
    // USD/USDC accordion removed (2026-09-19): nothing on this platform pays
    // in dollars any more (the USDC base toggle went the same way today).
    // Watched tokens from /tokens — balance + USD price + per-chain breakdown
    if (j.tokens && j.tokens.length) {
      h+='<div class="wallet-accordion open">';
      h+='<div class="wallet-accordion-header" onclick="_toggleAccordion(this)">';
      h+='<span class="wallet-token-icon" style="background:#4ade80;color:#0b0d10">&Sigma;</span>';
      h+='<span>Tokens</span>';
      h+='<span class="arrow" style="margin-left:auto">\u25b6</span>';
      h+='<span class="amount">$'+_wfu(j.tokens.reduce(function(s,t){return s+(t.balanceUsd||0);},0))+'</span>';
      h+='</div><div class="wallet-accordion-body">';
      j.tokens.forEach(function(t){
        var chainColor = { 'Ethereum':'#627eea', 'Base':'#0052FF', 'Robinhood Chain':'#00D54B' }[t.chainName] || '#444';
        var iconUrl = '/api/icon/token/' + encodeURIComponent(t.chain || 'ethereum') + '/' + t.address + '?s=' + encodeURIComponent(t.symbol || '');
        var pl = t.unrealizedPlUsd != null
          ? ' <span style="color:'+(t.unrealizedPlUsd >= 0 ? '#4ade80' : '#f87171')+';font-size:0.7rem">P/L '+(t.unrealizedPlUsd >= 0 ? '+' : '')+'$'+_wfu(Math.abs(t.unrealizedPlUsd))+'</span>'
          : '';
        var price = t.priceUsd != null ? '<span class="usd">@ $'+(t.priceUsd < 0.01 ? t.priceUsd.toPrecision(4) : _wfu(t.priceUsd))+'</span>' : '';
        h+='<div class="wallet-chain-row">';
        h+='<img class="wallet-token-icon" src="'+iconUrl+'" alt="" width="18" height="18" style="border-radius:3px">';
        h+='<span>'+_we(t.symbol || 'Unknown')+(t.positionError ? ' \u26a0' : '')+'</span>';
        h+='<span class="amount">'+_wf(t.balance)+'</span>';
        h+='<span class="usd">$'+_wfu(t.balanceUsd)+'</span>' + price + pl;
        h+='</div>';
      });
      h+='</div></div>';
    }
    h+='<div class="wallet-total-row"><span>Total</span><span class="amount">$'+_wfu(j.totalUsd)+'</span></div>';
    var ht=document.getElementById('walletHeaderTotal');
    if(ht) ht.textContent='$'+_wfu(j.totalUsd);
    c.innerHTML=h;
    // Append the smart-wallet transfer section (two cards, owner left / SCW right)
    loadSmartWalletSection();
  }catch(e){c.innerHTML='<div class="wallet-loading">'+_we(e.message)+'</div>';}
}

// ── Smart-wallet transfer section ──────────────────────────────────────────
// Two side-by-side cards (mobile: stacked): owner wallet left, Alchemy smart
// wallet right. Amount inputs sit next to each asset; "Move in" executes on
// the owner card, "Move out" on the smart-wallet card. Activate deploys the
// SCW (owner-paid factory tx, rangedesk pattern).
var _swState=null;
async function loadSmartWalletSection(){
  var host=document.getElementById('smartWalletSection');
  if(!host)return;
  host.innerHTML='<div class="wallet-loading">Loading smart wallet\u2026</div>';
  try{
    var qs = '/api/smart-wallet/status?chain=ethereum';
    if (_wcAddress) qs += '&wallet=' + encodeURIComponent(_wcAddress);
    var r=await fetch(qs); var j=await r.json();
    if(!j.ok){host.innerHTML='<div class="wallet-loading">'+_we(j.error||'unavailable')+'</div>';return;}
    _swState=j;
    renderSmartWalletSection();
  }catch(e){host.innerHTML='<div class="wallet-loading">'+_we(e.message)+'</div>';}
}
function _swAddr(a){return a? a.slice(0,6)+'\u2026'+a.slice(-4) : '\u2014';}
// Address row with a copy button — used on both cards. The FULL address is embedded
// as a data attribute (already validated 0x-hex by the status API) so the copy handler
// never has to reconstruct it.
function _swAddrRow(addr) {
  if (!addr) return '<div class="sw-addr">\u2014</div>';
  return '<div class="sw-addr"><span title="' + _we(addr) + '">' + _swAddr(addr) + '</span>' +
    '<button type="button" class="sw-copy" data-addr="' + _we(addr) + '" onclick="swCopyAddr(this)" title="Copy full address">\u29c9</button></div>';
}
function swCopyAddr(btn) {
  const addr = btn.getAttribute('data-addr');
  const done = () => {
    const orig = btn.textContent;
    btn.textContent = '\u2713';
    btn.style.color = '#4ade80';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(addr).then(done).catch(() => _swCopyFallback(addr, done));
  } else {
    _swCopyFallback(addr, done);
  }
}
function _swCopyFallback(text, done) {
  // clipboard API can be blocked on http:// origins — transient textarea fallback
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch {}
  ta.remove();
}
function renderSmartWalletSection(){
  var s=_swState; if(!s)return;
  var scw=s.scw||{}, owner=s.owner||{};
  // ── v2 wallet (user-EOA-owned, plan 2026-09-20): the "no session key" branch
  // now shows the user's OWN counterfactual SCW (owner = their EOA) with a
  // one-click browser-signed Activate. No key to generate, nothing to back up.
  if(s.schema===2){
    var ethUsd2=s.ethUsd||0;
    var imdPerEth2=s.imdPerEth||0;
    var imdUsd2=imdPerEth2>0?ethUsd2/imdPerEth2:0;
    var activated2=scw&&scw.activated;
    var browserWallet2=_wcAddress||null;
    var h2='';
    h2+='<div class="sw-head">Smart wallet <span class="hint">'+(activated2?'\u2713 deployed':'yours — 1 click to activate')+'</span></div>';
    h2+='<div class="sw-grid">';
    // Connected wallet card (owner)
    h2+='<div class="sw-card"><div class="sw-card-title">Your wallet <span class="hint">owner</span></div>';
    h2+=_swAddrRow(_wcAddress||owner.address);
    h2+='<div class="sw-asset"><span class="sw-token-icon" style="background:#627eea">&Xi;</span><span>ETH</span><span class="amount">'+bal(owner.eth)+'</span>'+usd(owner.eth!=null?owner.eth*ethUsd2:null)+'</div>';
    if(browserWallet2){
      h2+='<div class="sw-move-row"><input id="swInEth" type="number" step="0.0001" min="0" placeholder="0.00" oninput="swHint(&quot;swInEthHint&quot;,&quot;eth&quot;,this.value)"><button class="sw-btn" onclick="' + "swMove('in','eth')" + '">Fund \u2192</button></div>';
      h2+=swHintRow('swInEthHint');
      h2+='<div class="hint" style="margin-top:0.4rem;font-size:0.68rem">Funding signs in your browser wallet \u2014 keys never leave it.</div>';
    }
    h2+='</div>';
    // SCW card (user-EOA-owned)
    h2+='<div class="sw-card"><div class="sw-card-title">Smart wallet <span class="hint">'+_we(s.custodyLabel||'your EOA owns it')+'</span></div>';
    h2+=_swAddrRow(scw&&scw.address);
    h2+='<div class="sw-asset"><span class="sw-token-icon" style="background:#627eea">&Xi;</span><span>ETH</span><span class="amount">'+bal(scw&&scw.eth)+'</span>'+usd(scw&&scw.eth!=null?scw.eth*ethUsd2:null)+'</div>';
    // Move-out is browser-signed for v2 (owner EOA sends directly)
    if(browserWallet2){
      h2+='<div class="sw-move-row"><input id="swOutEth" type="number" step="0.0001" min="0" placeholder="0.00" oninput="swHint(&quot;swOutEthHint&quot;,&quot;eth&quot;,this.value)"><button class="sw-btn alt" onclick="' + "swMoveOutBrowser('eth')" + '">\u2190 Move out</button></div>';
      h2+=swHintRow('swOutEthHint');
      h2+='<div class="hint" style="margin-top:0.25rem;font-size:0.66rem">Sweep = sign in your wallet; the SCW \u2192 your EOA transfer rides inside the same tx.</div>';
    }
    h2+='<div class="sw-status" id="swStatus"></div>';
    h2+='<div style="margin-top:0.6rem">';
    if(!activated2){h2+='<button class="sw-btn activate" onclick="swActivateV2()">Activate smart wallet</button>';}
    else{
      h2+='<span class="hint">\u2713 deployed on-chain';
      if(s.grantStatus==='granted'){h2+=' \u00b7 \u2713 automation on (session key active)';}
      else if(s.grantStatus==='pending'){h2+=' \u00b7 grant pending \u2014 finish it below';}
      else{h2+=' \u2014 co-pilot mode';}
      h2+='</span>';
      if(browserWallet2&&s.grantStatus!=='granted'){
        h2+='<div style="margin-top:0.5rem"><button class="sw-btn alt" onclick="swGrantAutonomy()">'+(s.grantStatus==='pending'?'Finish grant (sign in wallet)':'Enable automated trading')+'</button></div>';
        h2+='<div class="hint" style="margin-top:0.25rem;font-size:0.66rem">Adds the app\u2019s session key as an operator of THIS wallet (one signed tx, \u22480.003 ETH gas). Skip it to stay in co-pilot \u2014 no key is ever stored until you do.</div>';
      }
    }
    h2+='</div></div>';
    h2+='</div>';
    document.getElementById('smartWalletSection').innerHTML=h2;
    return;
  }
  // NO SESSION KEY (2026-09-19, v1 wallets only): never show a smart-wallet card with a
  // fundable address — the only wallet the server could previously show here
  // was a global env burner that belongs to nobody. Co-pilot users see an
  // explicit explanation + path to autonomy instead.
  if(!s.hasSessionKey){
    var ethUsd0=s.ethUsd||0;
    var h0='';
    h0+='<div class="sw-head">Smart wallet <span class="hint">not set up</span></div>';
    h0+='<div class="sw-card" style="grid-column:1/-1">';
    h0+='<p class="hint" style="margin:0 0 0.6rem"><b>You are in Co-pilot mode</b> — every trade waits for your approval in the browser, and your connected wallet (above) signs it. The server holds no keys for you: that is the safest configuration.</p>';
    h0+='<p class="hint" style="margin:0 0 0.6rem">Want the app to trade automatically (watch dips, buy on schedule without asking)? <b>Generate a session key</b> in <b>Settings \u2192 Signer</b>. That creates YOUR smart wallet \u2014 a new address derived from your personal session key \u2014 which you fund with ETH; the app then trades from it without waiting for you.</p>';
    h0+='<p class="hint" style="margin:0;color:#e8b661">\u26a0 Only send funds to a smart wallet address shown here AFTER you generate the key \u2014 this screen shows no deposit address until then, on purpose.</p>';
    h0+='</div>';
    document.getElementById('smartWalletSection').innerHTML=h0;
    return;
  }
  if(scw.error){
    document.getElementById('smartWalletSection').innerHTML =
      '<div class="sw-head">Smart wallet</div><div class="wallet-loading" style="padding:0.75rem 0">'+_we(scw.error)+'</div>';
    return;
  }
  var activated=scw.activated;
  var ethUsd=s.ethUsd||0;
  var imdPerEth=s.imdPerEth||0;           // live ETH/IMD pool rate (0 → hints hidden)
  var imdUsd=imdPerEth>0?ethUsd/imdPerEth:0;   // IMD spot in USD
  var dsym=s.dollarSymbol||'USDC';
  var imdSym=s.imdSymbol||'IMD';
  var browserWallet=_wcAddress||null;   // set by wallet-connect.js (header session)
  var ownerTitle=browserWallet?'Connected wallet':'Owner wallet';
  function bal(v,sym){return v==null?'\u2014':_wf(v)+(sym?' '+sym:'');}
  function usd(v){return v==null?'':'<span class="usd">$'+_wfu(v)+'</span>';}
  var h='';
  h+='<div class="sw-head">Smart wallet <span class="hint">'+(activated?'\u2713 deployed':'not deployed')+'</span></div>';
  h+='<div class="sw-grid">';
  // ── Connected wallet card (left)
  h+='<div class="sw-card"><div class="sw-card-title">'+ownerTitle+'</div>';
  h+=_swAddrRow(browserWallet||owner.address);
  // ETH row
  h+='<div class="sw-asset"><span class="sw-token-icon" style="background:#627eea">&Xi;</span><span>ETH</span><span class="amount">'+bal(owner.eth)+'</span>'+usd(owner.eth!=null?owner.eth*ethUsd:null)+'</div>';
  h+='<div class="sw-move-row"><input id="swInEth" type="number" step="0.0001" min="0" placeholder="0.00" oninput="swHint(&quot;swInEthHint&quot;,&quot;eth&quot;,this.value)"><button class="sw-btn" onclick="' + "swMove('in','eth')" + '">Fund \u2192</button></div>';
  h+=swHintRow('swInEthHint');
  // USD row removed (2026-09-19): the platform no longer pays in dollars.
  // IMD row (only when the chain has IMD configured)
  if(s.imdPerEth!==undefined){
    h+='<div class="sw-asset"><span class="sw-token-icon" style="background:#e8b661;color:#0b0d10">'+_we(imdSym)+'</span><span>'+_we(imdSym)+'</span><span class="amount">'+bal(owner.imd)+'</span>'+usd(owner.imd!=null&&imdUsd>0?owner.imd*imdUsd:null)+'</div>';
    h+='<div class="sw-move-row"><input id="swInImd" type="number" step="1" min="0" placeholder="0.00" oninput="swHint(&quot;swInImdHint&quot;,&quot;imd&quot;,this.value)"><button class="sw-btn" onclick="' + "swMove('in','imd')" + '">Fund \u2192</button></div>';
    h+=swHintRow('swInImdHint');
  }
  if(browserWallet){
    h+='<div class="hint" style="margin-top:0.4rem;font-size:0.68rem">Funding signs in your browser wallet \u2014 keys never leave it.</div>';
  }
  h+='</div>';
  // ── SCW card (right)
  h+='<div class="sw-card"><div class="sw-card-title">Smart wallet <span class="hint">AA</span></div>';
  h+=_swAddrRow(scw.address);
  h+='<div class="sw-asset"><span class="sw-token-icon" style="background:#627eea">&Xi;</span><span>ETH</span><span class="amount">'+bal(scw.eth)+'</span>'+usd(scw.eth!=null?scw.eth*ethUsd:null)+'</div>';
  h+='<div class="sw-move-row"><input id="swOutEth" type="number" step="0.0001" min="0" placeholder="0.00" oninput="swHint(&quot;swOutEthHint&quot;,&quot;eth&quot;,this.value)"><button class="sw-btn ghost" onclick="swFillMax()" title="Fill the maximum sendable (balance minus this transaction gas)">MAX</button><button class="sw-btn alt" onclick="' + "swMove('out','eth')" + '">\u2190 Move out</button></div>';
  h+=swHintRow('swOutEthHint');
  // USD row removed (2026-09-19): the platform no longer pays in dollars.
  // IMD row on the SCW card too (session-key signed UO move-out)
  if(s.imdPerEth!==undefined){
    h+='<div class="sw-asset"><span class="sw-token-icon" style="background:#e8b661;color:#0b0d10">'+_we(imdSym)+'</span><span>'+_we(imdSym)+'</span><span class="amount">'+bal(scw.imd)+'</span>'+usd(scw.imd!=null&&imdUsd>0?scw.imd*imdUsd:null)+'</div>';
    h+='<div class="sw-move-row"><input id="swOutImd" type="number" step="1" min="0" placeholder="0.00" oninput="swHint(&quot;swOutImdHint&quot;,&quot;imd&quot;,this.value)"><button class="sw-btn alt" onclick="' + "swMove('out','imd')" + '">\u2190 Move out</button></div>';
    h+=swHintRow('swOutImdHint');
  }
  h+='<div class="sw-status" id="swStatus"></div>';
  h+='<div style="margin-top:0.6rem">';
  if(!activated){h+='<button class="sw-btn activate" onclick="swActivate()">Activate smart wallet</button>';}
  else{h+='<span class="hint">\u2713 deployed on-chain \u2014 ready for buys</span>';}
  h+='</div></div>';
  h+='</div>';
  document.getElementById('smartWalletSection').innerHTML=h;
}
async function swMove(direction,asset){
  var input=document.getElementById((direction==='in'?'swIn':'swOut')+(asset==='eth'?'Eth':(asset==='imd'?'Imd':'Usd')));
  if(!input||!_swState){return;}
  var amount=parseFloat(input.value);
  if(!(amount>0)){_swStatus('enter an amount');return;}
  // Browser-wallet funding: sign the transfer client-side (EIP-1193). The tx
  // goes straight to the chain from the extension; the server's role is balance
  // status only. No key material moves.
  // The from-address is ALWAYS the extension's ACTIVE account, resolved fresh
  // here — never the page-load-cached session address. Signing with a stale
  // identity produced "from should be same as current address" (2026-09-19):
  // the user switched accounts after sign-in and the extension rejected the tx.
  if(direction==='in' && window.ethereum && _wcAddress){
    var scwAddr=_swState.scw&&_swState.scw.address;
    if(!scwAddr){_swStatus('smart wallet not ready',false,true);return;}
    _swStatus('checking active account…',true);
    try{
      var accts=await window.ethereum.request({method:'eth_requestAccounts'});
      var from=accts&&accts[0];
      if(!from){_swStatus('no account active in your wallet',false,true);return;}
      if(_wcAddress && from.toLowerCase()!==_wcAddress.toLowerCase()){
        // Not an error — the SCW receives from anyone — but say it plainly.
        _swStatus('signing with '+from.slice(0,6)+'\u2026 (switched from '+_wcAddress.slice(0,6)+'\u2026)',true);
      }
      var txParams;
      if(asset==='eth'){
        txParams=fundingTxParams({from:from,scwAddress:scwAddr,asset:'eth',amount:amount,chain:_swState.chain});
      }else{
        // IMD funds the IMD token; anything else falls back to the dollar token.
        var tokenAddr=asset==='imd'?(_swState.imdToken||null):(_swState.dollarToken||null);
        var tokenDec=asset==='imd'?18:(_swState.scw&&_swState.scw.dollarDecimals!=null?_swState.scw.dollarDecimals:6);
        if(!tokenAddr){_swStatus('no '+_we(asset==='imd'?imdSym:dsym)+' token configured on this chain',false,true);return;}
        txParams=fundingTxParams({from:from,scwAddress:scwAddr,asset:'erc20',amount:amount,chain:_swState.chain,tokenAddress:tokenAddr,tokenDecimals:tokenDec});
      }
      _swStatus('signing in your wallet\u2026',true);
      var txHash=await window.ethereum.request({method:'eth_sendTransaction',params:[txParams]});
      _swStatus('\u2713 sent from your wallet \u2014 tx '+(txHash||'').slice(0,10)+'\u2026 reloading\u2026');
      setTimeout(function(){openWallet();},2200);
    }catch(e){
      if(e&&e.code===4001){_swStatus('rejected in wallet',false,true);return;}
      _swStatus(String(e.message||e).slice(0,160),false,true);
    }
    return;
  }
  // Server-signed paths: move-out (session key UO) and legacy in (server signer).
  _swStatus((direction==='in'?'Moving in\u2026':'Moving out\u2026'),true);
  try{
    var r=await fetch('/api/smart-wallet/move',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({direction:direction,asset:asset,amount:amount,chain:_swState.chain})});
    var j=await r.json();
    if(!j.ok)throw new Error(j.error||'failed');
    _swStatus('\u2713 sent \u2014 tx '+(j.txHash||'').slice(0,10)+'\u2026 reloading\u2026');
    setTimeout(function(){openWallet();},1800);
  }catch(e){_swStatus(String(e.message||e).slice(0,160),false,true);}
}
function chainIdHexFor(chain){
  return chain==='base'?'0x2105':(chain==='robinhood'?'0x1237':'0x1');
}
// Fund the activation gas key from the browser wallet, then automatically
// retry the (server-side) deploy — one user action, no address copying.
async function swFundGas(){
  if(!window.ethereum||!_swState||!_swState.gasPayer){_swStatus('gas key unknown — click Activate first',false,true);return;}
  var gasPayer=_swState.gasPayer;
  var amount=0.002;
  _swStatus('signing the gas funding send in your wallet…',true);
  try{
    var accts=await window.ethereum.request({method:'eth_requestAccounts'});
    var from=accts&&accts[0];
    if(!from){_swStatus('no account active in your wallet',false,true);return;}
    var wei='0x'+BigInt(Math.round(amount*1e18)).toString(16);
    var txHash=await window.ethereum.request({method:'eth_sendTransaction',params:[{from:from,to:gasPayer,value:wei,chainId:chainIdHexFor(_swState.chain)}]});
    _swStatus('gas funding sent — waiting for it to land, then deploying…',true);
    // Poll the gas key's balance until it shows the funds (max ~2 min), then
    // call Activate again — the server does the deploy itself.
    var deadline=Date.now()+120000;
    var funded=false;
    while(Date.now()<deadline){
      await new Promise(function(res){setTimeout(res,5000);});
      try{
        var chk=await fetch('/api/smart-wallet/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chain:_swState.chain,from:_wcAddress||null,checkOnly:true})});
        var cj=await chk.json();
        if(!cj.needsGas){funded=true;break;}
      }catch{}
    }
    if(funded){ await swActivate(); }
    else { _swStatus('gas funding not confirmed yet — click Activate in a moment',false,true); }
  }catch(e){
    if(e&&e.code===4001){_swStatus('rejected in wallet',false,true);return;}
    _swStatus(String(e.message||e).slice(0,160),false,true);
  }
}
// Hint placeholder row (renderSmartWalletSection references this at build time).
function swHintRow(id){return'<div class="sw-hint" id="'+id+'"></div>';}
// Live conversion hint under a move input — mirrors the sniper page's usd-line.
// ETH input → "≈ $x USD"; IMD input → "≈ x ETH · $y USD". Empty/zero → blank.
function swHint(id,asset,value){
  var el=document.getElementById(id); if(!el)return;
  var v=parseFloat(value)||0;
  var s=_swState||{};
  var ethUsd=s.ethUsd||0, imdPerEth=s.imdPerEth||0;
  if(!(v>0)){el.textContent='';return;}
  if(asset==='eth'){
    el.textContent=ethUsd>0?('\u2248 $'+_wfu(v*ethUsd)+' USD'):'';
  }else if(asset==='imd'){
    if(!(imdPerEth>0)){el.textContent='ETH/IMD rate unavailable';return;}
    var eth=v/imdPerEth;
    el.textContent='\u2248 '+eth.toLocaleString(void 0,{maximumFractionDigits:6})+' ETH'+(ethUsd>0?(' \u00b7 $'+_wfu(eth*ethUsd)+' USD'):'');
  }
}
// Fill the outbound ETH input with the live max-sendable (balance − exact gas cost
// of the sweep UO). Uses maxSendableEth from the status API when present.
function swFillMax() {
  const inp = document.getElementById('swOutEth');
  if (!inp || !_swState) return;
  const max = _swState.maxSendableEth;
  if (max != null && max > 0) {
    inp.value = max.toFixed(6);
    _swStatus('max sendable: ' + max.toFixed(6) + ' ETH (balance minus this tx\u2019s gas)');
  } else {
    // status didn't provide it (empty account / estimation unavailable) — use balance
    const b = _swState.scw && _swState.scw.eth;
    if (b > 0) { inp.value = b.toFixed(6); _swStatus('filled full balance \u2014 the move will clamp to the exact sendable amount'); }
    else _swStatus('no ETH to move');
  }
}
function _swStatus(msg,busy,err){
  var el=document.getElementById('swStatus'); if(!el)return;
  el.textContent=msg||''; el.style.color=err?'#f87171':(busy?'rgba(255,255,255,0.6)':'#4ade80');
}
async function swActivate(){
  var btn=event&&event.target;
  if(btn){btn.disabled=true;btn.textContent='Activating…';}
  // The deploy is signed SERVER-SIDE with the session key (msg.sender must be
  // the account owner — the factory silently no-ops for anyone else). Your
  // browser wallet is never prompted; the gas-key EOA pays and may need funding.
  _swStatus('preparing deploy…',true);
  try{
    var r=await fetch('/api/smart-wallet/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chain:_swState?_swState.chain:'ethereum',from:_wcAddress||null})});
    var j=await r.json();
    if(j.needsGas){
      // The deploy is signed by the wallet's own gas key (msg.sender must be
      // the account owner or the factory silently no-ops). ONE button chains
      // both steps: browser-signs the funding send, then auto-retries the
      // (server-side) deploy — no manual address copying, no extra inputs.
      _swState.gasPayer=j.gasPayer;   // remember it for swFundGas()
      if(btn){btn.disabled=false;btn.textContent='Fund & activate';}
      _swStatus('Activation needs deploy gas in the wallet\u2019s gas key (msg.sender = owner, else the factory no-ops). Click \u201cFund & activate\u201d and sign the \u2248'+_wfu(j.suggestedGasEth||0.002)+' ETH send — the deploy follows automatically.');
      var host=document.getElementById('smartWalletSection');
      if(host && j.gasPayer){
        var old=document.getElementById('gasKeyNote');
        if(old) old.remove();
        var note=document.createElement('div');
        note.id='gasKeyNote';
        note.className='sw-card';note.style.marginTop='0.6rem';
        note.innerHTML='<b style="color:#e8b661">Fund &amp; activate</b>'+
          '<div class="sw-move-row" style="margin-top:0.45rem"><button class="sw-btn" onclick="swFundGas()">Sign \u2248'+_wfu(j.suggestedGasEth||0.002)+' ETH \u2192 gas key, then auto-deploy</button></div>'+
          '<div class="hint" style="margin-top:0.25rem">Gas-key '+_swAddr(j.gasPayer)+' (balance '+_wfu(j.gasPayerBalanceEth)+' ETH) signs the deploy because the factory requires msg.sender = owner. Leftover gas stays as the wallet\u2019s operating float.</div>';
        var grid=host.querySelector('.sw-grid');
        if(grid){host.insertBefore(note,grid);}else{host.appendChild(note);}
      }
      return;
    }
    if(!j.ok)throw new Error(j.error||'deploy failed');
    // The deploy is signed SERVER-SIDE with the session key (owner-only
    // factory). The browser wallet is never prompted for activation.
    _swStatus(j.alreadyDeployed?'\u2713 already deployed':'\u2713 deploy sent — tx '+(j.txHash||'').slice(0,10)+'…');
    setTimeout(function(){openWallet();},2500);
  }catch(e){
    if(e&&e.code===4001){_swStatus('rejected in wallet',false,true);}
    else _swStatus(String(e.message||e).slice(0,180),false,true);
    if(btn){btn.disabled=false;btn.textContent='Activate smart wallet';}
  }
}
function closeWallet(){document.getElementById('walletOverlay').classList.remove('open');}
// ── v2 (user-EOA-owned) actions ──────────────────────────────────────────────
// Activate: server quotes the factory deploy; the BROWSER signs it. One click,
// owner-paid — no gas-key funding (your EOA is the owner by construction).
async function swActivateV2(){
  var btn=event&&event.target;
  if(btn){btn.disabled=true;btn.textContent='Activating…';}
  _swStatus('preparing deploy…',true);
  try{
    var r=await fetch('/api/smart-wallet/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chain:_swState?_swState.chain:'ethereum',from:_wcAddress||null})});
    var j=await r.json();
    if(!j.ok)throw new Error(j.error||'activate failed');
    if(j.alreadyDeployed){_swStatus('\u2713 already deployed');setTimeout(function(){openWallet();},1200);return;}
    if(!j.browserSign)throw new Error('unexpected activation payload');
    _swStatus('signing the deploy in your wallet…',true);
    var accts=await window.ethereum.request({method:'eth_requestAccounts'});
    var from=accts&&accts[0];
    if(!from){_swStatus('no account active in your wallet',false,true);return;}
    var txHash=await window.ethereum.request({method:'eth_sendTransaction',params:[{from:from,to:j.factory,data:j.callData,value:'0x0',chainId:chainIdHexFor(_swState.chain),gas:'0x'+Number(j.gasEstimate||200000).toString(16)}]});
    _swStatus('\u2713 deploy sent — tx '+(txHash||'').slice(0,10)+'… verifying…',true);
    // Poll for code at the SCW (max ~90s), mirroring the server-side guard.
    var deadline=Date.now()+90000;
    while(Date.now()<deadline){
      await new Promise(function(res){setTimeout(res,4000);});
      try{
        var chk=await fetch('/api/smart-wallet/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chain:_swState.chain,from:_wcAddress||null,checkOnly:true})});
        var cj=await chk.json();
        if(cj.alreadyDeployed){_swStatus('\u2713 smart wallet deployed — it is YOUR wallet now');setTimeout(function(){openWallet();},1500);return;}
      }catch{}
    }
    _swStatus('deploy not confirmed yet — click Activate again in a moment',false,true);
    if(btn){btn.disabled=false;btn.textContent='Activate smart wallet';}
  }catch(e){
    if(e&&e.code===4001){_swStatus('rejected in wallet',false,true);}
    else _swStatus(String(e.message||e).slice(0,180),false,true);
    if(btn){btn.disabled=false;btn.textContent='Activate smart wallet';}
  }
}
// ── v2 browser-submitted UOs (plan refinement 2026-09-20) ────────────────────
// The BROWSER submits handleOps itself (eth_sendTransaction): the user's EOA
// pays the relay gas from its own balance. No server relayer, no shared gas
// liability — the server only quotes calldata + the digest to sign. UO gas is
// refunded by the EntryPoint from the SCW's prefund (AA semantics).
// _padW: words/addresses RIGHT-aligned (ABI default). dataWL: dynamic bytes
// LEFT-aligned + zero-padded to nBytes. Both accept 0x-prefixed or bare hex.
var _padW=function(h,n){h=String(h||'0x');if(h.slice(0,2)!=='0x')h='0x'+h;h=h.slice(2);while(h.length<n*2)h='0'+h;return h;};
var dataWL=function(hex,nBytes){hex=hex||'';while(hex.length<nBytes*2)hex=hex+'0';return hex;};
// Sign the UO digest in the browser and submit handleOps from the user's EOA.
// quote = server payload (userOp, digestToSign, entryPoint).
async function swSignAndSubmit(quote,label){
  _swStatus('signing in your wallet…',true);
  var accts=await window.ethereum.request({method:'eth_requestAccounts'});
  var from=accts&&accts[0];
  if(!from)throw new Error('no account active in your wallet');
  var sig=await window.ethereum.request({method:'personal_sign',params:[quote.digestToSign,from]});
  // normalize v (some wallets return 0/1)
  var v=parseInt(sig.slice(-2),16);
  if(v===0||v===1)sig=sig.slice(0,-2)+(v+27).toString(16).padStart(2,'0');
  var uo=quote.userOp;
  uo.signature='0xFF00'+sig.slice(2); // packUOSignature: non-global entity format
  uo.accountGasLimits=_padW(uo.verificationGasLimit,16)+_padW(uo.callGasLimit,16);
  uo.gasFees=_padW(uo.maxPriorityFeePerGas,16)+_padW(uo.maxFeePerGas,16);
  var data=swHandleOpsData(uo,from);
  var txHash=await window.ethereum.request({method:'eth_sendTransaction',params:[{from:from,to:quote.entryPoint,data:data,chainId:chainIdHexFor(_swState.chain),gas:'0x'+Number(1200000).toString(16)}]});
  return txHash;
}
// Encode handleOps([struct], beneficiary) — byte-verified against viem's encoder
// for the real EP 0.7 ABI across six cases (empty/non-empty initCode, paymaster,
// odd-length callData, 2^72 nonce, packed signature). Layout:
//   head: arrayOffset(0x40), beneficiary, arrayLen(1), elementOffset(0x20)
//   tuple: sender, nonce, initCodeOff, callDataOff, accountGasLimits(bytes32),
//          preVerificationGas, gasFees(bytes32), pmOff, sigOff
//          (dynamic offsets relative to tuple start; tuple fixed area = 9 words)
//   tails: each dynamic member = length word + left-aligned data words
function swHandleOpsData(uo,beneficiary){
  var ic=(uo.initCode||'0x').slice(2), cd=uo.callData.slice(2),
      pm=(uo.paymasterAndData||'0x').slice(2), sig=uo.signature.slice(2);
  var tW=function(hex){return 32+Math.ceil(hex.length/64)*32;}; // tail bytes
  var icT=tW(ic), cdT=tW(cd), pmT=tW(pm), sigT=tW(sig);
  var icOff=9*32, cdOff=icOff+icT, pmOff=cdOff+cdT, sigOff=pmOff+pmT;
  var lenWord=function(hex){return _padW('0x'+(hex.length/2).toString(16),32);};
  return '0x765e827f' // handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)
    +_padW('0x40',32)
    +_padW(beneficiary,32)
    +_padW('0x1',32)
    +_padW('0x20',32)
    +_padW(uo.sender,32)
    +_padW(uo.nonce,32)
    +_padW('0x'+icOff.toString(16),32)
    +_padW('0x'+cdOff.toString(16),32)
    +_padW(uo.accountGasLimits,32)
    +_padW(uo.preVerificationGas,32)
    +_padW(uo.gasFees,32)
    +_padW('0x'+pmOff.toString(16),32)
    +_padW('0x'+sigOff.toString(16),32)
    +lenWord(ic)+dataWL(ic,icT-32)
    +lenWord(cd)+dataWL(cd,cdT-32)
    +lenWord(pm)+dataWL(pm,pmT-32)
    +lenWord(sig)+dataWL(sig,sigT-32);
}
// Move-out for v2: the OWNER signs a sweep UO (SCW → their EOA) and submits it
// from their own wallet — pays its own gas, works pre-grant (owner entity
// validates the UO, no session key involved).
async function swMoveOutBrowser(asset){
  var input=document.getElementById(asset==='eth'?'swOutEth':'swOutImd');
  if(!input||!_swState)return;
  var amount=parseFloat(input.value);
  if(!(amount>0)){_swStatus('enter an amount',false,true);return;}
  if(!window.ethereum||!_wcAddress){_swStatus('connect your wallet first',false,true);return;}
  _swStatus('preparing the sweep…',true);
  try{
    var r=await fetch('/api/smart-wallet/move-out-v2',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chain:_swState.chain,asset:asset,amount:amount,from:_wcAddress})});
    var j=await r.json();
    if(!j.ok)throw new Error(j.error||'sweep quote failed');
    if(!j.digestToSign)throw new Error('sweep payload missing digest');
    _swStatus('signing the sweep in your wallet…',true);
    var txHash=await swSignAndSubmit(j,'sweep');
    _swStatus('\u2713 sent — tx '+(txHash||'').slice(0,10)+'… reloading…');
    setTimeout(function(){openWallet();},2200);
  }catch(e){
    if(e&&e.code===4001){_swStatus('rejected in wallet',false,true);return;}
    _swStatus(String(e.message||e).slice(0,160),false,true);
  }
}
// Autonomy grant: quote → browser signs the digest → browser submits handleOps.
async function swGrantAutonomy(){
  var btn=event&&event.target;
  if(btn){btn.disabled=true;btn.textContent='Preparing grant…';}
  _swStatus('preparing the grant transaction…',true);
  try{
    var r=await fetch('/api/smart-wallet/grant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chain:_swState?_swState.chain:'ethereum',from:_wcAddress||null})});
    var j=await r.json();
    if(!j.ok)throw new Error(j.error||'grant quote failed');
    if(!j.digestToSign)throw new Error('grant payload missing digest');
    _swStatus('signing the grant in your wallet…',true);
    var txHash=await swSignAndSubmit(j,'grant');
    _swStatus('\u2713 grant sent — automation lands when the tx mines…',true);
    // Poll status until grantStatus flips (the server reads the chain, not our word)
    var deadline=Date.now()+180000;
    while(Date.now()<deadline){
      await new Promise(function(res){setTimeout(res,6000);});
      try{
        var c=await fetch('/api/smart-wallet/grant/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chain:_swState.chain})});
        var cj=await c.json();
        if(cj.ok&&cj.grantStatus==='granted'){
          _swStatus('\u2713 automation enabled — the app can now trade from your smart wallet');
          setTimeout(function(){openWallet();},1800);
          return;
        }
      }catch{}
    }
    _swStatus('grant submitted — automation activates when the tx lands',false,true);
    if(btn){btn.disabled=false;btn.textContent='Finish grant (sign in wallet)';}
  }catch(e){
    if(e&&e.code===4001){_swStatus('rejected in wallet',false,true);}
    else _swStatus(String(e.message||e).slice(0,180),false,true);
    if(btn){btn.disabled=false;btn.textContent='Enable automated trading';}
  }
}
async function refreshWallet(btn){
  var svg=btn.querySelector('svg');
  if(svg){svg.style.transition='transform 0.6s linear';svg.style.transform='rotate(360deg)';setTimeout(function(){svg.style.transition='none';svg.style.transform='rotate(0deg)';},650);}
  btn.disabled=true;btn.style.opacity='0.6';
  await openWallet();
  btn.disabled=false;btn.style.opacity='';
}
document.getElementById('walletOverlay').addEventListener('click',function(e){if(e.target===this)closeWallet();});
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeWallet();});
`;

export function walletSlideoutHtml() {
  return /* html */`
  <div class="wallet-overlay" id="walletOverlay">
    <div class="wallet-slideout" id="walletSlideout">
      <h3><span>Wallet <span class="wallet-header-total" id="walletHeaderTotal">—</span></span><span style="display:flex;align-items:center;gap:0.4rem"><button class="wallet-refresh" onclick="refreshWallet(this)" title="Refresh balances" style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:5px;color:#fafafa;cursor:pointer;padding:0">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-5.95h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
      </button><button class="wallet-close" onclick="closeWallet()">&times;</button></span></h3>
      <div id="smartWalletSection" style="margin-bottom:1rem"></div>
      <div class="wallet-loading" id="walletContent">Loading&hellip;</div>
    </div>
  </div>
  <script>${SLIDEOUT_JS}</script>`;
}

/** Read wallet-slideout.css as a string (sync, for inline embedding). */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
export const WALLET_SLIDEOUT_CSS = readFileSync(resolve(__dirname, "wallet-slideout.css"), "utf8");
