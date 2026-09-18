/**
 * sniper-autosell.mjs — server-side auto-sell loop for /sniper.
 *
 * Armed orders live in sniper_autosells (SQLite) and are executed here, in
 * the dashboard process — pm2 keeps the loop alive after the browser closes.
 * Trigger rule: position value (ETH) >= cost_at_arm_eth × (1 + target_pct/100),
 * where the cost basis is the net ETH cost of the position at arm time
 * (buys − recorded sell proceeds from sniper_trades). A hit sells 100%.
 */
import {
  getArmedSniperAutoSells,
  claimSniperAutoSell,
  settleSniperAutoSell,
} from "./db.mjs";
import { insertSniperTrade, getSniperTokenHistory } from "./db.mjs";
import { getSniperPosition, getTokenBalance, executeSniperSell, waitForTxReceipt } from "./sniper-extras.mjs";
import { resolveSigner } from "./signer.mjs";

const TICK_MS = 30_000;
let running = false;
let timer = null;

/** Chronological average-cost reconstruction of the sniper ledger — the ONE
 *  canonical P/L basis, mirroring wallet-position.mjs's method so the Sniper
 *  card, autosell arming, and the watcher position agree by construction.
 *  Buys push into an avg-cost pool (in ledger order); each sell removes its
 *  proportional cost and accumulates realized P/L. The previous netting math
 *  (buys − proceeds) was chronology-blind: post-exit buys (late wallet-sync
 *  backfill, mirrored strategy buys) leaked into the sold units' basis
 *  (HASH 2026-09-14: realized showed ≈0 instead of the true ≈+$5).
 *  Sell rows are SELL*, PROBE* (probe's sell leg), AUTOSELL* — "PROBE
 *  DELIVERED" doesn't start with SELL, which the old counters missed. */
export function sniperLedgerStats(chainKey, token) {
  let qty = 0, costPool = 0, boughtEth = 0, soldEth = 0, buys = 0, sells = 0, realizedEth = 0;
  let unknownSellProceeds = false;
  for (const t of getSniperTokenHistory(chainKey, token)) {
    const spent = Number(t.eth_spent || 0);
    const got = Number(t.eth_received || 0);
    const tokens = Math.abs(Number(t.token_amount || 0));
    if (/^(SELL|PROBE|AUTOSELL)/.test(String(t.dex || ""))) {
      sells++;
      soldEth += got;
      if (t.eth_received == null) unknownSellProceeds = true;
      const removed = Math.min(tokens, qty);
      const costRemoved = qty > 0 ? costPool * (removed / qty) : 0;
      costPool -= costRemoved;
      qty -= removed;
      realizedEth += got - costRemoved;
    } else if (spent > 0) {
      qty += tokens;
      costPool += spent;
      boughtEth += spent;
      buys++;
    }
  }
  return { qty, openCostBasis: Math.max(costPool, 0), boughtEth, soldEth, buys, sells, realizedEth, unknownSellProceeds };
}

/** Open-position cost basis in ETH (chronological avg-cost pool) — used for
 *  autosell arm targets. NOTE: it is the OPEN basis, not net flows — arming
 *  against net flows would understate the target whenever past exits exist. */
export function netCostEthFor(chainKey, token) {
  return sniperLedgerStats(chainKey, token).openCostBasis;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const armed = getArmedSniperAutoSells();
    for (const order of armed) {
      try {
        if (!claimSniperAutoSell(order.id)) continue; // someone else claimed it
        const chainKey = order.chain;
        const token = order.contract_address;

        const signer = await resolveSigner(chainKey);
        const bal = await getTokenBalance(chainKey, token, signer.address);
        if (!(bal.formatted > 0)) {
          settleSniperAutoSell(order.id, { error: "position balance is 0" });
          continue;
        }

        const pos = await getSniperPosition(chainKey, token);
        const ethUsd = Number(pos.ethUsd || 0);
        let openEth = 0;
        if (Number(pos.formatted) > 0 && ethUsd > 0 && Number(pos.valueUsd) > 0) {
          openEth = Number(pos.valueUsd) / ethUsd;
        }
        const targetEth = Number(order.cost_at_arm_eth) * (1 + Number(order.target_pct) / 100);
        if (!(openEth >= targetEth)) {
          // Not there yet — put it back for the next tick.
          settleSniperAutoSell(order.id, { revertToArmed: true, error: null });
          continue;
        }

        // Trigger: sell 100% of the balance. executeSniperSell now waits for the
        // on-chain receipt and throws on revert, so a failed sell lands in the
        // catch below as a terminal 'error' — never a false 'triggered'.
        const result = await executeSniperSell({
          signer, chainKey, tokenAddress: token, amountHuman: bal.formatted, slippagePct: 3,
        });
        const receipt = await waitForTxReceipt(chainKey, result.txHash);
        insertSniperTrade({
          chain: chainKey,
          contract_address: token,
          symbol: bal.symbol ?? order.symbol ?? null,
          dex: "AUTOSELL " + (result.label || result.dex),
          eth_spent: 0,
          token_amount: bal.formatted,
          buy_tx_hash: result.txHash,
          eth_received: result.ethReceived ?? null,
        });
        settleSniperAutoSell(order.id, { txHash: result.txHash });
        console.log(`[autosell] triggered #${order.id} ${order.symbol ?? token} on ${chainKey}: tx ${result.txHash}`);
      } catch (e) {
        // Terminal error state — no automatic retry (a failed sell may have
        // spent gas/approvals; re-arming is a deliberate user action).
        settleSniperAutoSell(order.id, { error: e.message });
        console.error(`[autosell] #${order.id} failed:`, e.message);
      }
    }
  } catch (e) {
    console.error("[autosell] tick error:", e.message);
  } finally {
    running = false;
  }
}

/** Start the loop (idempotent). Called once from dashboard.mjs at boot. */
export function startSniperAutoSellLoop() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  // First pass shortly after boot, not instantly — let RPC clients warm up.
  setTimeout(tick, 5_000);
  console.log("[autosell] loop started (30s ticks)");
}
