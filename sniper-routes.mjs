/**
 * sniper-routes.mjs — /sniper API handlers.
 */
import { insertSniperTrade, getSniperTokenHistory, touchSniperToken, getSniperRecentTokens, getSniperActiveToken, armSniperAutoSell, cancelSniperAutoSells, getSniperAutoSells, getArmedSniperAutoSells, getDipWatchers, setSniperTokenVerified, getSniperTokenVerification } from "./db.mjs";
import { netCostEthFor, sniperLedgerStats } from "./sniper-autosell.mjs";
import { discoverPools, executeSniperBuy, getEthUsd, getTokenMeta } from "./sniper-swap.mjs";
import { resolveSigner } from "./signer.mjs";
import {
  getQuoteContext,
  getTokenBalance,
  getSniperPosition,
  getApprovals,
  approveSpender,
  executeSniperSell,
} from "./sniper-extras.mjs";
import { publicClient } from "./sniper-swap.mjs";
import { sniperPage } from "./sniper-page.mjs";
import { syncExternalTrades } from "./wallet-sync.mjs";
import { probeSellDeliverability } from "./sell-probe.mjs";
import { recordGasForTx } from "./gas-ledger.mjs";

const SNIPER_CHAINS = ["ethereum", "base", "robinhood"];

function wrapSignerGas(signer, maxGasGwei) {
  const gwei = parseFloat(maxGasGwei);
  if (!(gwei > 0)) {
    // MAINNET GAS FIX (2026-09-15): the VultiSig SDK broadcast an FWAI buy with
    // maxFee 0.097 gwei and ~0 priority fee — Robinhood-scale numbers. Ethereum
    // validators skipped it and the mempool evicted it (no gas lost, no buy).
    // When no explicit cap is set on mainnet, force a real priority fee and let
    // the SDK estimate maxFee on top of current baseFee.
    return {
      ...signer,
      callContract(opts) {
        if (opts.maxPriorityFeePerGas) return signer.callContract(opts);
        return signer.callContract({ ...opts, maxPriorityFeePerGas: 1_500_000_000n }); // 1.5 gwei
      },
    };
  }
  const maxFeePerGas = BigInt(Math.round(gwei * 1e9));
  const maxPriorityFeePerGas = 1_000_000n;
  return {
    ...signer,
    callContract(opts) {
      return signer.callContract({ ...opts, maxFeePerGas, maxPriorityFeePerGas });
    },
  };
}

export async function handleSniperRequest(url, method, { readBody, json, send, shell, esc, explorerLink, getChain, sessionAddress = null, req = null }) {
  // Per-user read wallet (2026-09-18): balances belong to the session user —
  // their registry SCW / users-table key / connected wallet, never the global
  // env signer (which on hosted shows 0 for everyone).
  let readWallet = null;
  let readWallets = null; // SCW + browser EOA — launchpad buys land in the EOA
  // NOTE: sessionAddress needs the REQUEST to read the cookie — passing
  // null made it throw, silently skipping per-user resolution and falling
  // back to the global signer (balance 0 for everyone on /sniper).
  // uid is declared OUTSIDE the try so every route below can use it —
  // inside the try it died with the block scope (ReferenceError on /sniper,
  // 2026-09-19: "uid is not defined" at the page render).
  let uid = null;
  try {
    uid = sessionAddress ? sessionAddress(req) : null;
    if (uid) {
      const { resolveUserReadWallets } = await import("./smart-wallet-api.mjs");
      readWallets = await resolveUserReadWallets(uid, "ethereum");
      readWallet = readWallets[0];
    }
  } catch { /* fall through to per-route resolution */ }
  if (url === "/sniper" && method === "GET") {
    let ctx = { chain: "ethereum", ethUsd: 0, ethBalance: 0, usdcBalance: 0, ethUsdValue: 0, imdPerEth: 0 };
    try {
      let owner = readWallet;
      if (!owner) { try { owner = (await resolveSigner("ethereum")).address; } catch {} }
      ctx = { chain: "ethereum", ...(await getQuoteContext("ethereum", owner)) };
    } catch {}
    // The bot's current target: active token auto-resumes on page load.
    ctx.activeToken = getSniperActiveToken("ethereum");
    send(sniperPage({ shell, esc, explorerLink, getChain, ctx, userId: uid }));
    return true;
  }

  // Smart token input: remembered tokens (with Dexscreener icons) + which is
  // currently active for this chain.
  if (url === "/api/sniper/recent" && method === "POST") {
    try {
      const { chain } = JSON.parse(await readBody() || "{}");
      const chainKey = chain || "ethereum";
      json({ ok: true, chain: chainKey, tokens: getSniperRecentTokens(chainKey, 12, uid), active: getSniperActiveToken(chainKey) });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  if (url === "/api/sniper/context" && method === "POST") {
    try {
      const body = JSON.parse(await readBody());
      const chainKey = body.chain || "ethereum";
      if (!SNIPER_CHAINS.includes(chainKey)) { json({ ok: false, error: "unsupported chain" }); return true; }
      let owner = readWallet;
      if (!owner) { try { owner = (await resolveSigner(chainKey)).address; } catch {} }
      json({ ok: true, ...(await getQuoteContext(chainKey, owner)) });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  if (url === "/api/sniper/discover" && method === "POST") {
    try {
      const { chain, token, ethAmount } = JSON.parse(await readBody());
      if (!token?.match(/^0x[0-9a-fA-F]{40}$/)) { json({ ok: false, error: "invalid token address" }); return true; }
      const chainKey = chain || "ethereum";
      if (!SNIPER_CHAINS.includes(chainKey)) { json({ ok: false, error: "sniper supports ethereum and base only" }); return true; }
      const disc = await discoverPools(chainKey, token, ethAmount || "0.01");
      // Smart input memory: remember the token + make it this chain's active
      // target (stays active until a different token is entered).
      if (disc?.symbol) touchSniperToken({ chain: chainKey, contract_address: token, symbol: disc.symbol, activate: true });
      json({ ok: true, ...(disc) });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  if (url === "/api/sniper/buy" && method === "POST") {
    let body = {};
    try {
      body = JSON.parse(await readBody());
      const { chain, token, symbol, decimals, ethAmount, slippagePct, pool, maxGasGwei } = body;
      if (!token?.match(/^0x[0-9a-fA-F]{40}$/)) { json({ ok: false, error: "invalid token address" }); return true; }
      const chainKey = chain || "ethereum";
      const signer = wrapSignerGas(await resolveSigner(chainKey), maxGasGwei);
      const amountWei = BigInt(Math.round(parseFloat(ethAmount) * 1e18));
      const bal = await signer.getEthBalanceWei();
      if (bal < amountWei) throw new Error(`insufficient ETH (have ${Number(bal)/1e18}, need ${ethAmount})`);
      let result;
      if (pool?.dex && pool.dex !== "CURVE") {
        result = await executeSniperBuy({ signer, chainKey, tokenAddress: token, ethAmount, slippagePct: parseFloat(slippagePct)||3, pool });
      } else {
        // No pool chosen: either the user skipped discovery or the token is an
        // IMD-launchpad curve coin (zero AMM venues exist). buyToken's dispatcher
        // runs the proven curve path when the indexer lists the token; otherwise
        // it throws a meaningful venue error.
        const { buyToken, getEthUsdPrice } = await import("./dip-swap.mjs");
        const ethUsd = await getEthUsd(chainKey).catch(() => 0);
        if (!(ethUsd > 0)) throw new Error("ETH/USD price unavailable — cannot size the buy");
        const usdSize = parseFloat(ethAmount) * ethUsd;
        const r2 = await buyToken(signer, token, usdSize, { slippagePct: parseFloat(slippagePct)||3, pool: null, chainKey });
        result = { txHash: r2.txHash, quotedOut: r2.quotedOut, label: r2.curve ? "IMD curve" : "dip-swap routed", eth_spent: r2.eth_spent };
      }
      const tokenAmount = decimals != null ? Number(result.quotedOut) / (10 ** Number(decimals)) : null;
      // eth_spent = what the wallet actually paid, in ETH terms. ETH-paid buys
      // spend the entered amount; dollar-paid routed buys (USDG) convert their
      // usd_spent at the live rate — the ledger must never record the INTENDED
      // ETH size for a swap that actually paid USDG.
      let ethSpent = parseFloat(ethAmount);
      if (result.eth_spent != null) ethSpent = Number(result.eth_spent);
      else if (result.usd_spent != null) {
        const rate = await getEthUsd(chainKey).catch(() => 0);
        if (rate > 0) ethSpent = Number(result.usd_spent) / rate;
      }
      insertSniperTrade({ chain: chainKey, contract_address: token.toLowerCase(), symbol: symbol ?? null, dex: result.label || result.dex, eth_spent: ethSpent, token_amount: tokenAmount, buy_tx_hash: result.txHash, user_id: uid });
      // A snipe starts a bot session: the bought token becomes the chain's
      // active target until a different token is entered.
      touchSniperToken({ chain: chainKey, contract_address: token, symbol: symbol ?? null, activate: true });
      json({ ok: true, txHash: result.txHash, quotedOut: result.quotedOut.toString(), label: result.label });
      return true;
    } catch (e) {
      try {
        if (body?.token) insertSniperTrade({ chain: body.chain || "ethereum", contract_address: String(body.token).toLowerCase(), symbol: body.symbol ?? null, dex: body.pool?.label || body.pool?.dex, eth_spent: body.ethAmount ? parseFloat(body.ethAmount) : null, status: "error", error: e.message, user_id: uid });
      } catch {}
      json({ ok: false, error: e.message }); return true;
    }
  }

  // Honeypot probe: sell a tiny slice of the position and verify proceeds
  // actually land in the wallet (QUORUM-style honeypots swap fine and deliver
  // nothing — only an empirical sell can prove deliverability).
  // A DELIVERED verdict marks the token "verified" (sniper_recent_tokens).
  if (url === "/api/sniper/sell-probe" && method === "POST") {
    try {
      const { chain, token, pool, probeEth } = JSON.parse(await readBody());
      if (!token?.match(/^0x[0-9a-fA-F]{40}$/)) { json({ ok: false, error: "invalid token address" }); return true; }
      const chainKey = chain || "ethereum";
      const signer = await resolveSigner(chainKey);
      const bal = await getTokenBalance(chainKey, token, signer.address);
      if (!(bal.formatted > 0)) { json({ ok: false, error: "no balance to probe — buy first (the probe sells a slice of your position)" }); return true; }
      // Probe size: ~$1 of the position (capped at 5% so a huge position
      // isn't churned), denominated in ETH→tokens at the live price.
      const pos = await getSniperPosition(chainKey, token);
      const ethUsd = Number(pos.ethUsd || 0);
      const probeUsd = Number(probeEth ?? 1);
      let probeTokens;
      if (pos.formatted > 0 && pos.valueUsd > 0 && ethUsd > 0) {
        const tokenUsd = pos.valueUsd / Number(pos.formatted);
        probeTokens = Math.min(Number(pos.formatted) * 0.05, probeUsd / tokenUsd);
      } else {
        probeTokens = Number(pos.formatted) * 0.01; // can't price it — 1% of the bag
      }
      if (!(probeTokens > 0)) { json({ ok: false, error: "could not size a probe from this position" }); return true; }
      const probe = await probeSellDeliverability({ signer, chainKey, tokenAddress: token, amountHuman: probeTokens, pool: pool ?? null });
      // Record the probe as a trade so P/L reflects reality either way.
      if (probe.sellTxHash) {
        insertSniperTrade({ chain: chainKey, contract_address: token.toLowerCase(), symbol: bal.symbol, dex: `PROBE ${probe.verdict.toUpperCase()}`, eth_spent: 0, token_amount: probeTokens, buy_tx_hash: probe.sellTxHash, eth_received: probe.verdict === "delivered" ? (probe.deltaRaw != null ? Number(probe.deltaRaw) / 1e18 : null) : 0, user_id: uid });
      }
      if (probe.verdict === "delivered") setSniperTokenVerified(chainKey, token, "probe");
      json({ ok: true, ...probe, probeTokens, verified: probe.verdict === "delivered" });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  // Honeypot ROUND-TRIP test: miniscule buy → immediate 100% sell → verify
  // the proceeds land. One click proves a token end-to-end (buy-side entry
  // AND sell-side deliverability) for the cost of spread + gas on ~$1.
  // Marks the token "verified" on success; on failure returns the reason and
  // does NOT mark anything (a token that bought but won't sell back is the
  // classic trap).
  if (url === "/api/sniper/verify" && method === "POST") {
    let body = {};
    try {
      body = JSON.parse(await readBody());
      const { chain, token, symbol, decimals, pool, maxGasGwei } = body;
      if (!token?.match(/^0x[0-9a-fA-F]{40}$/)) { json({ ok: false, error: "invalid token address" }); return true; }
      if (!pool?.dex) { json({ ok: false, error: "pick a pool first (check liquidity)" }); return true; }
      const chainKey = chain || "ethereum";
      // Exposure cap: the round-trip risks ~$2 max (spread + gas).
      const ethUsd = Number(await getEthUsd(chainKey).catch(() => 0));
      const PROBE_USD = 1;
      let probeEth = 0.001; // fallback ~$2.5 on mainnet, ~$0.01-scale on 4663 gas-wise
      if (ethUsd > 0) probeEth = Math.min(0.01, PROBE_USD / ethUsd);
      const signer = wrapSignerGas(await resolveSigner(chainKey), maxGasGwei);
      const bal0 = await signer.getEthBalanceWei().catch(() => 0n);
      if (bal0 < BigInt(Math.round(probeEth * 1e18))) { json({ ok: false, error: "insufficient ETH for the probe" }); return true; }

      // 1. miniscule buy — curve coins have no pool object; dispatch via buyToken
      let buy;
      if (pool?.dex === "CURVE" || !pool?.dex) {
        const { buyToken } = await import("./dip-swap.mjs");
        const ethUsdP = await getEthUsd(chainKey).catch(() => 0);
        const usdSize = ethUsdP > 0 ? PROBE_USD : Number(probeEth);
        const r2 = await buyToken(signer, token, usdSize, { slippagePct: 5, pool: null, chainKey });
        buy = { txHash: r2.txHash, quotedOut: r2.quotedOut, label: "IMD curve" };
      } else {
        buy = await executeSniperBuy({ signer, chainKey, tokenAddress: token, ethAmount: probeEth, slippagePct: 5, pool });
      }
      const dec = Number(decimals ?? 18);
      let bought = Number(buy.quotedOut ?? 0n) / 10 ** dec;
      // 2. immediately sell the entire probe position.
      // Sell the ON-CHAIN balance, not the quoted out — tokens with a transfer
      // tax (very common on Base) credit the wallet less than quoted, and
      // selling the quoted amount reverts STF and masks a sellable token.
      const balAfterBuy = await getTokenBalance(chainKey, token, signer.address).catch(() => null);
      if (balAfterBuy?.formatted > 0) bought = Math.min(bought, balAfterBuy.formatted);
      if (!(bought > 0)) {
        json({ ok: false, error: `probe buy returned 0 tokens (tx ${buy.txHash}) — cannot test the sell side`, buyTxHash: buy.txHash });
        return true;
      }
      const sell = await probeSellDeliverability({ signer, chainKey, tokenAddress: token, amountHuman: bought, pool });
      // 3. ledger both legs
      const ethUsdNow = Number(await getEthUsd(chainKey).catch(() => 0));
      let ethSpent = Number(probeEth);
      if (buy.usd_spent != null) ethSpent = ethUsdNow > 0 ? Number(buy.usd_spent) / ethUsdNow : Number(probeEth);
      insertSniperTrade({ chain: chainKey, contract_address: token.toLowerCase(), symbol: symbol ?? null, dex: (buy.label || buy.dex || "BUY") + " (verify)", eth_spent: ethSpent, token_amount: bought, buy_tx_hash: buy.txHash, user_id: uid });
      if (sell.sellTxHash) {
        insertSniperTrade({ chain: chainKey, contract_address: token.toLowerCase(), symbol: symbol ?? null, dex: `PROBE ${sell.verdict.toUpperCase()}`, eth_spent: 0, token_amount: bought, buy_tx_hash: sell.sellTxHash, eth_received: sell.verdict === "delivered" ? (sell.deltaRaw != null ? Number(sell.deltaRaw) / 1e18 : null) : 0, user_id: uid });
      }
      if (sell.verdict === "delivered") setSniperTokenVerified(chainKey, token, "probe");
      const verified = getSniperTokenVerification(chainKey, token);
      json({
        ok: true,
        verdict: sell.verdict,
        verified: sell.verdict === "delivered",
        verifiedAt: verified?.verified_at ?? null,
        buyTxHash: buy.txHash,
        sellTxHash: sell.sellTxHash ?? null,
        probeEth, bought,
        reason: sell.reason ?? null,
      });
      return true;
    } catch (e) {
      // Persist the failed verify so it shows in the ledger — a silent verify
      // looks like the button is broken (nothing was recorded for any failed
      // Base attempt, so failures were indistinguishable from "never ran").
      try {
        if (body?.token) insertSniperTrade({ chain: body.chain || "base", contract_address: String(body.token).toLowerCase(), symbol: body.symbol ?? null, dex: "VERIFY FAILED", eth_spent: null, status: "error", error: e.message, user_id: uid });
      } catch {}
      json({ ok: false, error: e.message });
      return true;
    }
  }

  if (url === "/api/sniper/approvals" && method === "POST") {
    try {
      const { chain, token } = JSON.parse(await readBody());
      const signer = await resolveSigner(chain || "base");
      json({ ok: true, rows: await getApprovals(chain || "base", signer.address, token) });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  if (url === "/api/sniper/approve" && method === "POST") {
    try {
      const { chain, token, spender, maxGasGwei } = JSON.parse(await readBody());
      const signer = wrapSignerGas(await resolveSigner(chain || "base"), maxGasGwei);
      json({ ok: true, txHash: await approveSpender(signer, token, spender) });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  if (url === "/api/sniper/position" && method === "POST") {
    try {
      const { chain, token } = JSON.parse(await readBody());
      const chainKey = chain || "ethereum";
      json({ ok: true, ...(await getSniperPosition(chainKey, token, { walletOverrides: readWallets })) });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  // P/L card for the token in the address box: live balance/value from the
  // existing position path, plus net cost basis & realized P/L built from
  // sniper_trades (buys carry eth_spent; sells carry eth_received).
  if (url === "/api/sniper/pl" && method === "POST") {
    try {
      const { chain, token } = JSON.parse(await readBody());
      if (!token?.match(/^0x[0-9a-fA-F]{40}$/)) { json({ ok: false, error: "invalid token address" }); return true; }
      const chainKey = chain || "ethereum";
      const pos = await getSniperPosition(chainKey, token, { walletOverrides: readWallets });
      if (pos.ok === false) { json({ ok: false, error: pos.error }); return true; }

      // Ledger stats via the ONE canonical chronological avg-cost function
      // (sniper-autosell.mjs) — same method as wallet-position.mjs, so the
      // Sniper card and the watcher position agree by construction. The
      // previous inline netting formula was chronology-blind: post-exit buys
      // (late sync backfill, mirrored strategy buys) leaked into the sold
      // units' basis and shifted P/L between realized and unrealized
      // (HASH 2026-09-14: realized showed ≈0 instead of the true ≈+$5).
      const stats = sniperLedgerStats(chainKey, token, uid);
      const { boughtEth, soldEth, buys, sells, realizedEth: realizedPnl, unknownSellProceeds } = stats;

      // Open position valued in ETH via the same 0.01-ETH probe the position
      // endpoint uses (valueUsd = holdings worth X ETH at the live quote).
      const ethUsd = Number(pos.ethUsd || 0);
      let openEth = 0;
      if (Number(pos.formatted) > 0 && ethUsd > 0 && Number(pos.valueUsd) > 0) {
        openEth = Number(pos.valueUsd) / ethUsd;
      }
      // Two DISTINCT numbers. Unrealized = open value minus the cost still
      // tied up in the OPEN position (the chronological avg-cost pool).
      // Realized = proceeds banked from sells minus the cost those sold
      // units carried, accumulated per-sell inside sniperLedgerStats.
      const openCostBasis = stats.openCostBasis;
      // P/L applies to HELD tokens only. When the live quote fails (valueUsd 0
      // while holding), unrealized is UNKNOWN — never a fabricated -100% (the
      // old formula rendered any quote failure as a total loss).
      const quoteFailed = Number(pos.formatted) > 0 && Number(pos.valueUsd || 0) === 0;
      const unrealizedEth = quoteFailed ? null : openEth - openCostBasis;
      json({
        ok: true,
        chain: chainKey,
        token,
        symbol: pos.symbol ?? null,
        balance: pos.formatted ?? 0,
        valueUsd: Number(pos.valueUsd || 0),
        ethUsd,
        quoteFailed,
        boughtEth, soldEth, buys, sells,
        netCostEth: openCostBasis,
        realizedEth: realizedPnl,
        unrealizedEth,
        realizedUnknown: unknownSellProceeds,
      });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  // Auto-sell: arm against existing holdings (no buy required). Target is
  // measured against the position's net cost basis in ETH at arm time.
  if (url === "/api/sniper/autosell/arm" && method === "POST") {
    try {
      const { chain, token, targetPct } = JSON.parse(await readBody());
      if (!token?.match(/^0x[0-9a-fA-F]{40}$/)) { json({ ok: false, error: "invalid token address" }); return true; }
      const pct = parseFloat(targetPct);
      if (!(pct > 0 && pct <= 100000)) { json({ ok: false, error: "profit target must be > 0 (%)" }); return true; }
      const chainKey = chain || "ethereum";
      // Honeypot guard: refuse to arm an autosell on a token whose ledger
      // shows a previous sell that delivered nothing (QUORUM signature —
      // arming an autosell on an unsellable token just arms a donation).
      const stiffed = getSniperTokenHistory(chainKey, token).find((t) =>
        String(t.dex ?? "").startsWith("SELL") && Number(t.eth_received ?? 0) <= 0);
      if (stiffed) {
        json({ ok: false, error: `refusing to arm: this token's ledger has a sell with $0 proceeds (tx ${stiffed.buy_tx_hash ?? "?"}) — honeypot signature. The autosell would fire into a token that can't be sold.` });
        return true;
      }
      const cost = netCostEthFor(chainKey, token, uid);
      const disc = await discoverPools(chainKey, token, "0.01").catch(() => null);
      const armed = armSniperAutoSell({
        chain: chainKey,
        contract_address: token,
        symbol: disc?.symbol ?? null,
        target_pct: pct,
        cost_at_arm_eth: cost,
        user_id: uid,
      });
      json({ ok: true, id: armed, costEth: cost, targetEth: cost * (1 + pct / 100), symbol: disc?.symbol ?? null });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  if (url === "/api/sniper/autosell/cancel" && method === "POST") {
    try {
      const { chain, token } = JSON.parse(await readBody());
      const chainKey = chain || "ethereum";
      const cancelled = cancelSniperAutoSells(chainKey, token);
      json({ ok: true, cancelled });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  if (url === "/api/sniper/autosell/list" && method === "POST") {
    try {
      const { chain } = JSON.parse(await readBody() || "{}");
      const chainKey = chain || "ethereum";
      json({ ok: true, orders: getSniperAutoSells(chainKey, 10, uid), armed: getArmedSniperAutoSells(chainKey).length });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  if (url === "/api/sniper/sell" && method === "POST") {
    try {
      const { chain, token, sellPct, slippagePct, maxGasGwei, pool } = JSON.parse(await readBody());
      if (!token?.match(/^0x[0-9a-fA-F]{40}$/)) { json({ ok: false, error: "invalid token address" }); return true; }
      const chainKey = chain || "ethereum";
      const signer = wrapSignerGas(await resolveSigner(chainKey), maxGasGwei);
      const bal = await getTokenBalance(chainKey, token, signer.address);
      const pct = Math.min(100, Math.max(1, parseFloat(sellPct) || 100));
      const amountHuman = bal.formatted * (pct / 100);
      if (!(amountHuman > 0)) throw new Error("token balance is 0");
      const result = await executeSniperSell({ signer, chainKey, tokenAddress: token, amountHuman, slippagePct: parseFloat(slippagePct)||3, pool });
      insertSniperTrade({ chain: chainKey, contract_address: token.toLowerCase(), symbol: bal.symbol, dex: "SELL " + (result.label || result.dex), eth_spent: 0, token_amount: amountHuman, buy_tx_hash: result.txHash, eth_received: result.ethReceived ?? null, user_id: uid });
      // Selling this token makes it the bot's active target — the wallet's
      // position you're acting on should follow the token in the box.
      touchSniperToken({ chain: chainKey, contract_address: token.toLowerCase(), symbol: bal.symbol ?? null, activate: true });
      // Honeypot guard: a "successful" swap with zero recorded proceeds is
      // the QUORUM signature (sold fine, delivered nothing). Stamp the ledger
      // so P/L reflects the loss and the UI can surface the verdict.
      const got = Number(result.ethReceived ?? 0);
      if (Number(result.amountIn ?? 0) > 0 && !(got > 0)) {
        console.error(`[sniper] HONEYPOT GUARD: ${bal.symbol ?? token} sell returned no proceeds — ${result.txHash}`);
        json({ ok: true, ...result, honeypotSuspected: true, honeypotNote: "The swap succeeded but NO proceeds were recorded as delivered. This token is likely not sellable (honeypot). Do not buy more." });
        return true;
      }
      json({ ok: true, ...result });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  // Migrate this token from Sniper to Accumulation: ensure a dip_watcher row
  // exists (created dormant — no plan, paused), then the UI opens the plan
  // modal on /tokens. Does NOT trade or move anything.
  if (url === "/api/sniper/migrate" && method === "POST") {
    try {
      const { chain, token, symbol, pool } = JSON.parse(await readBody());
      if (!token?.match(/^0x[0-9a-fA-F]{40}$/)) { json({ ok: false, error: "invalid token address" }); return true; }
      const chainKey = chain || "ethereum";
      if (!SNIPER_CHAINS.includes(chainKey)) { json({ ok: false, error: "unsupported chain" }); return true; }
      const { addDipWatcher, getDipWatchers, setDipWatcherActive, setDipWatcherPool } = await import("./db.mjs");
      const addr = token.toLowerCase();
      const existing = getDipWatchers().find((w) => w.chain === chainKey && String(w.contract_address).toLowerCase() === addr);
      if (existing) {
        // Carry the sniper's chosen pool across even on the re-migrate path —
        // a watcher with no pool breaks computeWalletPosition on hooked/token-
        // only-V4 tokens (HASH: "No WETH pool found" killed the P/L card).
        if (pool?.poolAddress && !existing.pool_address) setDipWatcherPool(existing.id, pool.poolAddress);
        json({ ok: true, watcherId: existing.id, symbol: existing.symbol ?? symbol ?? null, created: false });
        return true;
      }
      const meta = await getTokenMeta(chainKey, token);
      const id = crypto.randomUUID();
      addDipWatcher({
        id, chain: chainKey, contractAddress: addr, symbol: meta.symbol || symbol || "TOKEN", decimals: meta.decimals ?? 18,
        thresholdUsd: 0, buyAmountUsd: 0, slippagePct: 3, cooldownMinutes: 15,
        // The sniper ALREADY resolved the venue (chosenPool — the pool the user
        // just verified/bought through). Persist it: without it every consumer
        // (computeWalletPosition, exits, MM) re-resolves blind and hooked V4
        // pools fall off a cliff ("No WETH pool found on V3").
        poolAddress: pool?.poolAddress ?? null,
      });
      setDipWatcherActive(id, 0); // dormant until a plan is set
      json({ ok: true, watcherId: id, symbol: meta.symbol || symbol || "TOKEN", created: true });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  // Pull trades made outside the app (Uniswap UI etc.) into the ledger, so
  // P/L + autosell baselines reflect the wallet's real history.
  if (url === "/api/sniper/wallet-sync" && method === "POST") {
    try {
      const { chain, token } = JSON.parse(await readBody());
      if (!token?.match(/^0x[0-9a-fA-F]{40}$/)) { json({ ok: false, error: "invalid token address" }); return true; }
      const chainKey = chain || "ethereum";
      // Sync reads the USER's wallet (2026-09-18) — the session user's SCW /
      // connected wallet, not the global env signer.
      const wallet = readWallet || (await resolveSigner(chainKey)).address;
      // Scan EVERY read wallet (2026-09-19): launchpad/curve buys execute from
      // the browser EOA while app-signed trades hit the SCW — syncing one
      // wallet alone misses the other's external trades entirely.
      const wallets = readWallets ?? (wallet ? [wallet] : null) ?? [(await resolveSigner(chainKey)).address];
      // SEQUENTIAL, not parallel: the dedupe set (known tx hashes) is read at
      // the start of each sync — two concurrent syncs would both see an empty
      // set and double-insert any tx touching both wallets (e.g. a transfer
      // between a user's own SCW and EOA).
      const per = [];
      for (const w of wallets) {
        per.push(await syncExternalTrades({ chainKey, tokenAddress: token, wallet: w, userId: uid }));
      }
      const r = per.reduce((acc, x) => ({ added: acc.added + x.added, skipped: acc.skipped + x.skipped }), { added: 0, skipped: 0 });
      json({ ok: true, wallets, ...r });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  if (url === "/api/sniper/tx" && method === "POST") {
    try {
      const { chain, txHash } = JSON.parse(await readBody());
      const chainKey = chain || "ethereum";
      const receipt = await publicClient(chainKey).waitForTransactionReceipt({ hash: txHash, timeout: 240_000 });
      recordGasForTx(txHash, chainKey).catch(() => {}); // gas ledger
      json({ ok: true, status: receipt.status });
      return true;
    } catch (e) { json({ ok: false, error: e.message }); return true; }
  }

  return false;
}
