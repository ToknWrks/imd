#!/usr/bin/env node
// diag-selectors2.mjs — wide selector wordlist sweep (hook-gating vocabulary)
// for the two unknown revert selectors, verified by keccak hash.
import { keccak256, toHex } from "viem";

const targets = { "0x6a12f104": [], "0xff633a38": [] };
const hits = {};

const VERBS = ["Not", "Non", "Un", "Only", "Invalid", "Wrong", "Bad", "No", "Zero", "Insufficient", "Exceeded", "Blocked", "Banned", "Forbidden", "Denied", "Restricted"];
const NOUNS = ["Authorized", "Allowed", "Whitelisted", "Approved", "Permitted", "AuthorizedCaller", "Admin", "Owner", "Creator", "Deployer", "Minter", "Whitelist", "Member", "User", "Sender", "Caller", "Eoa", "EOA"];
const STATES = ["Trading", "TradingOpen", "TradingEnabled", "Launch", "LaunchPhase", "Presale", "Sale", "Bonding", "Graduated", "Migrated", "Vesting", "Lockup", "Cooldown", "Delay", "Window", "Period", "Epoch", "Round"];
const MISC = ["DeadlinePassed", "DeadlineExpired", "DeadlineExceeded", "Deadline", "Timestamp", "Time", "Past", "Expired", "Matured", "Open", "Closed", "Active", "Inactive", "Paused", "Live", "Over", "Started", "Ended", "BeforeStart", "AfterEnd", "NotYetOpen", "TooEarly", "TooLate", "WrongTime", "BadTime", "Gate", "GateClosed", "Gated", "Ungated"];

const pool = new Set();
for (const n of [...NOUNS, ...STATES]) {
  pool.add(n + "()");
  for (const v of VERBS) pool.add(v + n + "()");
  for (const t of ["address", "uint256", "uint64", "uint40", "uint32"]) {
    pool.add(n + "(" + t + ")");
    for (const v of VERBS) pool.add(v + n + "(" + t + ")");
    for (const u of ["address,uint256", "uint256,address"]) {
      pool.add(n + "(" + u + ")");
      for (const v of VERBS) pool.add(v + n + "(" + u + ")");
    }
  }
}
// common solid names
for (const s of ["TradingNotOpen()", "TradingNotOpen(uint256,uint256)", "TradingNotYetOpen(uint256)", "NotOpenYet()", "NotOpen()",
  "StillInBondingCurve()", "StillOpen()", "SellDisabled()", "BuyDisabled()", "Disabled()", "TransferDenied()", "TransferNotAllowed()",
  "HookCallerMustBePoolManager()", "NotPoolManager()", "OnlyPoolManager()", "OnlyPool()", "CallerMustBePool()", "NotPool()", "UnauthorizedCaller(address)",
  "InvalidUnlocker()", "NotUnlocker()", "UnlockFailed()", "SwapLocked(uint256)", "LockedUntil(uint256)", "CantSwapYet(uint256)",
  "EarlySell(uint256)", "EarlySellPenalty()", "AntiSnipe()", "AntiSnipeActive()", "SniperBlocked()", "BotTax()", "BotTax(uint256)"]) pool.add(s);

for (const name of pool) {
  const sel = keccak256(toHex(name)).slice(0, 10);
  if (sel in targets) targets[sel].push(name);
}
for (const [sel, found] of Object.entries(targets)) {
  console.log(sel, "->", found.length ? found.join(" | ") : "(no match)");
}
