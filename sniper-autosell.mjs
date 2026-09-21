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
import { resolveSigner, resolveSignerUser } from "./signer.mjs";
import { formatUnits } from "viem";

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
export function sniperLedgerStats(chainKey, token, userId = null) {
  // Per-user (2026-09-19): P/L math must use ONLY the session user's ledger
  // rows (+ NULL-legacy rows) — another user's trades on the same token must
  // never shift this user's cost basis or realized P/L.
  let qty = 0, costPool = 0, boughtEth = 0, soldEth = 0, buys = 0, sells = 0, realizedEth = 0;
  let unknownSellProceeds = false;
  for (const t of getSniperTokenHistory(chainKey, token, userId)) {
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
export function netCostEthFor(chainKey, token, userId = null) {
  return sniperLedgerStats(chainKey, token, userId).openCostBasis;
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

        // Sign as the ORDER'S OWNER (2026-09-19): an armed autosell belongs to
        // a specific user — sell THEIR tokens with THEIR signer, never the
        // global env signer. Copilot-mode users get their browser-approval
        // flow via resolveSignerUser; autonomy users get their session key.
        const signer = await resolveSignerUser(order.user_id, chainKey);
        const bal = await getTokenBalance(chainKey, token, signer.address);
        if (!(bal.formatted > 0)) {
          settleSniperAutoSell(order.id, { error: "position balance is 0" });
          continue;
        }

        const pos = await getSniperPosition(chainKey, token, { walletOverride: signer.address });
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

        // Trigger: sell 100% of the balance. Full-precision string from the
        // raw balance (2026-09-21 fix) — bal.formatted is a lossy float, and
        // round-tripping it back to wei can overshoot the real on-chain
        // balance on large-supply tokens, reverting the transferFrom even
        // with a sufficient Permit2 allowance (found live on manual sniper
        // sells; autosell shares the identical pattern). executeSniperSell
        // now waits for the on-chain receipt and throws on revert, so a
        // failed sell lands in the catch below as a terminal 'error' —
        // never a false 'triggered'.
        const amountHuman = formatUnits(BigInt(bal.raw), bal.decimals);
        const result = await executeSniperSell({
          signer, chainKey, tokenAddress: token, amountHuman, slippagePct: 3,
        });
        const receipt = await waitForTxReceipt(chainKey, result.txHash);
        insertSniperTrade({
          chain: chainKey,
          contract_address: token,
          symbol: bal.symbol ?? order.symbol ?? null,
          dex: "AUTOSELL " + (result.label || result.dex),
          eth_spent: 0,
          token_amount: Number(amountHuman),
          buy_tx_hash: result.txHash,
          eth_received: result.ethReceived ?? null,
          user_id: order.user_id ?? null,
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
