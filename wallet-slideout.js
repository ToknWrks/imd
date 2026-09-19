/**
 * wallet-slideout.js — slideout overlay HTML + inline JS.
 * Returns a string of HTML (overlay div + script tag) to embed in every page.
 */

export const WALLET_NAV_BUTTON = `<button class="wallet-nav-btn" onclick="openWallet()" title="Wallet"
  style="display:flex;align-items:center;justify-content:center;width:36px;height:36px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:#fafafa;cursor:pointer;padding:0;">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21 7.28V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2.28A2 2 0 0 0 22 15V9a2 2 0 0 0-1-1.72zM20 9v6h-7V9h7zM5 19V5h14v2h-5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h5v2H5z"/></svg>
</button>`;

// JS helpers embedded in the slideout script
const SLIDEOUT_JS = /* js */`
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
    j.eth.chains.forEach(function(c){
      h+='<div class="wallet-chain-row">'+
        '<span class="chain-icon" style="background:'+c.color+';color:#fff">'+c.initials+'</span>'+
        '<span>'+c.name+(c.error?' <span style="color:#f87171;font-size:0.7rem">\u26a0</span>':'')+'</span>'+
        '<span class="amount">'+_wf(c.balance)+' ETH</span>'+
        '<span class="usd">$'+_wfu(c.balanceUsd)+'</span>'+
        '</div>';
    });
    h+='</div></div>';
    var dl=j.usd.chains.some(function(c){return c.symbol==='USDG';})?'USD':'USDC';
    h+='<div class="wallet-accordion">'+
      '<div class="wallet-accordion-header" onclick="_toggleAccordion(this)">'+
      '<span class="wallet-token-icon" style="background:#2775ca;color:#fff">$</span>'+
      '<span>'+dl+'</span>'+
      '<span class="arrow" style="margin-left:auto">\u25b6</span>'+
      '<span class="amount">$'+_wfu(j.usd.totalUsd)+'</span>'+
      '</div><div class="wallet-accordion-body">';
    j.usd.chains.forEach(function(c){
      h+='<div class="wallet-chain-row">'+
        '<span class="chain-icon" style="background:'+c.color+';color:#fff">'+c.initials+'</span>'+
        '<span>'+c.name+(c.error?' <span style="color:#f87171;font-size:0.7rem">\u26a0</span>':'')+'</span>'+
        '<span class="amount">'+_wf(c.balance)+' '+_we(c.symbol)+'</span>'+
        '<span class="usd">$'+_wfu(c.balanceUsd)+'</span>'+
        '</div>';
    });
    h+='</div></div>';
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
  // NO SESSION KEY (2026-09-19): never show a smart-wallet card with a
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
  var dsym=s.dollarSymbol||'USDC';
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
  h+='<div class="sw-move-row"><input id="swInEth" type="number" step="0.0001" min="0" placeholder="0.00"><button class="sw-btn" onclick="' + "swMove('in','eth')" + '">Fund \u2192</button></div>';
  // USD row
  h+='<div class="sw-asset"><span class="sw-token-icon" style="background:#2775ca">$</span><span>'+dsym+'</span><span class="amount">'+bal(owner.usd)+'</span>'+usd(owner.usd)+'</div>';
  h+='<div class="sw-move-row"><input id="swInUsd" type="number" step="0.01" min="0" placeholder="0.00"><button class="sw-btn" onclick="' + "swMove('in','usd')" + '">Fund \u2192</button></div>';
  if(browserWallet){
    h+='<div class="hint" style="margin-top:0.4rem;font-size:0.68rem">Funding signs in your browser wallet \u2014 keys never leave it.</div>';
  }
  h+='</div>';
  // ── SCW card (right)
  h+='<div class="sw-card"><div class="sw-card-title">Smart wallet <span class="hint">AA</span></div>';
  h+=_swAddrRow(scw.address);
  h+='<div class="sw-asset"><span class="sw-token-icon" style="background:#627eea">&Xi;</span><span>ETH</span><span class="amount">'+bal(scw.eth)+'</span>'+usd(scw.eth!=null?scw.eth*ethUsd:null)+'</div>';
  h+='<div class="sw-move-row"><input id="swOutEth" type="number" step="0.0001" min="0" placeholder="0.00"><button class="sw-btn ghost" onclick="swFillMax()" title="Fill the maximum sendable (balance minus this transaction gas)">MAX</button><button class="sw-btn alt" onclick="' + "swMove('out','eth')" + '">\u2190 Move out</button></div>';
  h+='<div class="sw-asset"><span class="sw-token-icon" style="background:#2775ca">$</span><span>'+dsym+'</span><span class="amount">'+bal(scw.usd)+'</span>'+usd(scw.usd)+'</div>';
  h+='<div class="sw-move-row"><input id="swOutUsd" type="number" step="0.01" min="0" placeholder="0.00"><button class="sw-btn alt" onclick="' + "swMove('out','usd')" + '">\u2190 Move out</button></div>';
  h+='<div class="sw-status" id="swStatus"></div>';
  h+='<div style="margin-top:0.6rem">';
  if(!activated){h+='<button class="sw-btn activate" onclick="swActivate()">Activate smart wallet</button>';}
  else{h+='<span class="hint">\u2713 deployed on-chain \u2014 ready for buys</span>';}
  h+='</div></div>';
  h+='</div>';
  document.getElementById('smartWalletSection').innerHTML=h;
}
async function swMove(direction,asset){
  var input=document.getElementById((direction==='in'?'swIn':'swOut')+(asset==='eth'?'Eth':'Usd'));
  if(!input||!_swState){return;}
  var amount=parseFloat(input.value);
  if(!(amount>0)){_swStatus('enter an amount');return;}
  // Browser-wallet funding: sign the transfer client-side (EIP-1193), then the
  // server just relays nothing — the tx goes straight to the chain from the
  // extension. The server's role is balance status only. No key material moves.
  if(direction==='in' && _wcAddress){
    if(!window.ethereum){_swStatus('no browser wallet connected',false,true);return;}
    var scwAddr=_swState.scw&&_swState.scw.address;
    if(!scwAddr){_swStatus('smart wallet not ready',false,true);return;}
    var chainIdHex=_swState.chain==='base'?'0x2105':(_swState.chain==='robinhood'?'0x1237':'0x1');
    _swStatus('signing in your wallet\u2026',true);
    try{
      var txHash;
      if(asset==='eth'){
        var weiEth='0x'+Math.round(amount*1e18).toString(16);
        txHash=await window.ethereum.request({method:'eth_sendTransaction',params:[{from:_wcAddress,to:scwAddr,value:weiEth,chainId:chainIdHexFor(_swState.chain)}]});
      }else{
        // ERC-20 transfer via data field — balance read for sanity first.
        var dec=_swState.scw.dollarDecimals!=null?_swState.scw.dollarDecimals:6;
        var raw='0x'+BigInt(Math.round(amount*(10**dec))).toString(16).padStart(64,'0');
        var toPadded=scwAddr.replace(/^0x/,'').toLowerCase().padStart(64,'0');
        // transfer(address,uint256) selector = a9059cbb
        var data='0xa9059cbb'+toPadded+raw;
        var tokenAddr=_swState.dollarToken;
        if(!tokenAddr){_swStatus('no '+dsym+' token configured on this chain',false,true);return;}
        txHash=await window.ethereum.request({method:'eth_sendTransaction',params:[{from:_wcAddress,to:tokenAddr,data:data,chainId:chainIdHexFor(_swState.chain)}]});
      }
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
  if(btn){btn.disabled=true;btn.textContent='Activating\u2026';}
  _swStatus('deploying smart wallet (owner pays gas)\u2026',true);
  try{
    var r=await fetch('/api/smart-wallet/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chain:_swState?_swState.chain:'ethereum'})});
    var j=await r.json();
    if(!j.ok)throw new Error(j.error||'deploy failed');
    _swStatus(j.alreadyDeployed?'\u2713 already deployed':'\u2713 deployed — '+ (j.txHash||'').slice(0,10)+'\u2026');
    setTimeout(function(){openWallet();},1800);
  }catch(e){_swStatus(String(e.message||e).slice(0,180),false,true); if(btn){btn.disabled=false;btn.textContent='Activate smart wallet';}}
}
function closeWallet(){document.getElementById('walletOverlay').classList.remove('open');}
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
