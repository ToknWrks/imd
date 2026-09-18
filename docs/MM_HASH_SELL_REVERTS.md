# MM_HASH_SELL_REVERTS.md — 2026-09-13 session findings

(Working notes — promote to CLAUDE.md Hard-Won Lessons on request; CLAUDE.md
edits require explicit user approval.)

## What happened

HASH MM sells reverted 5+ times with `V4TooLittleReceived` (selector
`0x8b063d73` — decode via openchain.xyz; viem can't decode it because the UR
call's ABI lacks the V4 errors). Two 5-error streaks auto-paused the strategy.
Ledger showed ONLY the healthy buy row — the failures left zero trace.

## Root causes

1. **Failed MM legs recorded nothing.** `executeLeg` only wrote trade rows on
   success. FIXED 2026-09-13: `executeLeg` now wraps `runLeg` in try/catch and
   inserts a `status:'error'` row with the message before rethrowing.
   `computeMmPosition` filters `status='ok'` so error rows never touch P/L.
   (Same lesson as the Sniper VERIFY FAILED fix of 2026-09-12.)
2. **Fee-0 hooked pools quote above what they pay.** HASH's deep pool
   `0x42b009f3…` = (ETH, HASH, fee=0, tickSpacing=60, hook
   `0xCA757986…02aCC`). Verified via StateView: live, L≈2.2e21, deep. The good
   exit sells (139 HASH → 0.0195 ETH) went through the SAME pool, so pool
   targeting is correct. The reverts are the hook's execution delta being worse
   than the quoter's simulated delta — the slippage buffer must cover hook
   slippage too, not just pool depth.
   - Mitigation in flight: user raised slippage 3% → 5%.
   - If reverts persist: principled fix = sniper-style fair-value proceeds
     guard inside `executeMmSell` (refuse when quoted proceeds <X% of fair
     value — mirrors executeSniperSell's <50% refusal).

## Diagnostics worth keeping

- V4 error selectors: `0x8b063d73` = `V4TooLittleReceived(uint256,uint256)`.
- Deriving a poolId from a UR swap's path leg: leg =
  (intermediateCurrency, fee, tickSpacing, hooks); poolKey currencies must be
  the SORTED pair (ETH=0x0 sorts before any token). The failed-tx blob's leg
  words were (mid=HASH-as-currencyIn, then leg mid=0x0/ETH, fee=0, ts=60,
  hooks=ca757986…) → poolId 0x42b009f3 = the deep pool. Confirmed by receipts:
  both good sells emitted V4 Swap on 0x42b009f3.
- PoolKey cache: `data/v4-poolkey-cache.json` keyed `chain:poolId`. HASH entry
  was correct (fee 0, ts 60, hook ca757986).
- Alchemy robinhood getLogs still capped at 10 blocks; Blockscout getLogs API
  requires explicit fromBlock/toBlock params (403 without browser UA otherwise).
- pm2 restart after any watcher code change (already standing convention).
