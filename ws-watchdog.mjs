/**
 * ws-watchdog.mjs — liveness watchdog for dip-watcher WebSocket subscriptions.
 *
 * The failure mode this kills (CLAUDE.md Risks TODO): a dropped Swap-event
 * subscription only logged via onError — nothing removed the dead entry or
 * re-subscribed, so dip detection stayed silently dead until a manual restart.
 *
 * What viem already does (verified in viem 2.56.3 source): its webSocket
 * transport reconnects (default 5 attempts, 2s apart) and REPLAYS active
 * subscriptions on successful reconnect. What it does NOT do:
 *   - it gives up after 5 failed attempts and CLEARS the subscription map —
 *     the watchEvent stays registered but silent forever;
 *   - a half-dead socket (LB recycle, proxy timeout) can hang with no error
 *     event firing at all.
 *
 * So this watchdog PROVES liveness instead of assuming it: every
 * WATCHDOG_PROBE_S it opens a short `newHeads` subscription on the same
 * transport and waits up to 3 block-times for one block head. A live socket
 * delivers promptly regardless of pool activity (thin pools can honestly go
 * hours with no swaps — Swap silence is NOT evidence of death).
 *
 * No head in the window (or probe setup error) => the cached socket client is
 * closed outright and every subscription on the chain is rebuilt from scratch
 * via the caller's `rebuild()` (dip-watcher's per-chain reconcile). Alerts via
 * notify.mjs: stall detected, rebuild failure (forced), recovery confirmed.
 *
 * One watchdog per chain, module-level singleton.
 */

import { getWsClient, getChain } from "./chains.mjs";
import { alert } from "./notify.mjs";

const PROBE_MS = () => Math.max(15, Number(process.env.WATCHDOG_PROBE_S ?? 120)) * 1000;
const STALL_BLOCKS = () => Math.max(2, Number(process.env.WATCHDOG_STALL_BLOCKS ?? 5));
const REBUILD_COOLDOWN_MS = () => Math.max(30_000, Number(process.env.WATCHDOG_REBUILD_COOLDOWN_S ?? 120) * 1000);
const BLOCK_TIME_MS = (chainKey) => getChain(chainKey).blockTimeMs ?? 15_000;

// chainKey -> { timer, rebuilding, recoveryPending, lastRebuildAt, rebuild }
const _watchdogs = new Map();
let _probeInFlight = false;

/** Called from every Swap onLogs handler — records that data is flowing. */
export function noteWsActivity(chainKey) {
  const wd = _watchdogs.get(chainKey);
  if (wd) wd.lastDataAt = Date.now();
}

/** Start (or replace) the watchdog for a chain. `rebuild()` re-subscribes everything on that chain. */
export function startWatchdog(chainKey, rebuild) {
  stopWatchdog(chainKey);
  const dep = getChain(chainKey);
  const wd = { chainKey, rebuild, rebuilding: false, recoveryPending: false, lastRebuildAt: 0, timer: null };
  _watchdogs.set(chainKey, wd);
  wd.timer = setInterval(() => runProbe(chainKey).catch(() => {}), PROBE_MS());
  wd.timer.unref?.();
  console.log(`[ws-watchdog] armed on ${dep.name} — newHeads probe every ${PROBE_MS() / 1000}s; no head within ~${Math.round((BLOCK_TIME_MS(chainKey) * 3) / 1000)}s triggers a full subscription rebuild`);
}

export function stopWatchdog(chainKey) {
  const wd = _watchdogs.get(chainKey);
  if (wd) { clearInterval(wd.timer); _watchdogs.delete(chainKey); }
}

async function runProbe(chainKey) {
  if (_probeInFlight) return; // one probe at a time across chains
  const wd = _watchdogs.get(chainKey);
  if (!wd || wd.rebuilding) return;
  _probeInFlight = true;
  let sub = null;
  try {
    const client = getWsClient(chainKey);
    const timeoutMs = BLOCK_TIME_MS(chainKey) * 3;
    const headPromise = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), timeoutMs);
      t.unref?.();
      wd._resolveHead = (v) => { clearTimeout(t); resolve(v); };
    });
    sub = await client.transport.subscribe({
      params: ["newHeads"],
      onData: (data) => { wd._resolveHead?.(data?.result ?? true); wd._resolveHead = null; },
      onError: () => {},
    });
    const got = await headPromise;
    try { await sub.unsubscribe(); } catch {}
    sub = null;

    if (got) {
      if (wd.recoveryPending) {
        wd.recoveryPending = false;
        wd.lastRebuildAt = Date.now();
        await alert(`ws-${chainKey}-stall`, `WebSocket on ${getChain(chainKey).name} recovered — subscriptions rebuilt and blocks flowing again`, { resolved: true });
      }
    } else {
      await handleStall(wd, `no block heads within ~${Math.round(timeoutMs / 1000)}s on the newHeads probe`);
    }
  } catch (e) {
    await handleStall(wd, `newHeads probe failed: ${e.message}`);
  } finally {
    try { if (sub) await sub.unsubscribe(); } catch {}
    _probeInFlight = false;
  }
}

async function handleStall(wd, reason) {
  if (wd.rebuilding) return;
  const now = Date.now();
  if (now - wd.lastRebuildAt < REBUILD_COOLDOWN_MS()) {
    console.log(`[ws-watchdog] ${wd.chainKey}: stall (${reason}) — within rebuild cooldown, waiting`);
    return;
  }
  wd.rebuilding = true;
  wd.recoveryPending = true;
  const dep = getChain(wd.chainKey);
  await alert(`ws-${wd.chainKey}-stall`, `WebSocket stall on ${dep.name}: ${reason}. Closing the socket client and rebuilding all ${dep.name} subscriptions.`);
  try {
    // Close the cached socket client outright — viem's 5-attempt reconnect may
    // already be exhausted, so a fresh client is the only reliable path.
    try {
      const rpc = await clientRpc(wd.chainKey);
      rpc?.close?.();
    } catch {}
    await wd.rebuild();
    wd.lastRebuildAt = Date.now();
    console.log(`[ws-watchdog] rebuild complete on ${dep.name} — recovery confirmed on the next probe`);
  } catch (e) {
    await alert(`ws-${wd.chainKey}-rebuild-fail`, `WebSocket rebuild FAILED on ${dep.name}: ${e.message} — dip detection may be DOWN. Check pm2 logs; consider ./imd.sh restart.`, { force: true });
  } finally {
    wd.rebuilding = false;
  }
}

// The transport exposes the underlying rpc client via getRpcClient() (a
// promise). close() ends the socket and evicts the cache entry, so the next
// getWsClient() call in rebuild() builds a brand-new connection.
async function clientRpc(chainKey) {
  const client = getWsClient(chainKey);
  const transport = client.transport;
  if (transport?.getRpcClient) return await transport.getRpcClient();
  return null;
}
