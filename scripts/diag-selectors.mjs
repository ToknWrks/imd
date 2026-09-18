#!/usr/bin/env node
// diag-selectors.mjs — brute-force keccak selectors against a wordlist of
// plausible hook/UR error names; then test the user's tx with a FRESH deadline
// from THEIR address (isolate sender gating from deadline staleness).
import { keccak256, toHex } from "viem";

const target1 = "0x6a12f104"; // user's tx replayed today (their address)
const target2 = "0xff633a38"; // our replicated tx (our address)

const NAMES = [
  "DeadlinePassed(uint256)", "DeadlineExpired()", "NotAuthorized()", "Unauthorized()",
  "CallerNotAllowed()", "SenderNotAllowed()", "NotAllowed()", "Forbidden()",
  "Unauthorized(address)", "NotAllowed(address)", "CallerNotAuthorized(address)",
  "Unauthorized(address,address)", "NotApproved(address)", "OnlyCreator()", "OnlyOwner()",
  "OwnableUnauthorizedAccount(address)", "AccessControlUnauthorizedAccount(address,bytes32)",
  "InvalidSender()", "InvalidRecipient(address)", "BadRecipient()", "WrongRecipient()",
  "FeeTooHigh()", "MinOutNotMet()", "TooLittleReceived()", "SlippageLimitExceeded()",
  "TradingNotOpen()", "TradingDisabled()", "TradingClosed()", "NotTradingActive()",
  "PoolLocked()", "Locked()", "HookLocked()", "ReentrancyGuardReentrantCall()",
  "NoLiquidity()", "InsufficientLiquidity()", "PoolNotInitialized()", "PoolClosed()",
  "SellLimitExceeded()", "BuyLimitExceeded()", "MaxBuyExceeded()", "LimitExceeded()",
  "OnlyWhitelisted()", "WhitelistOnly()", "NotWhitelisted(address)", "NotWhitelisted()",
  "MinterOnly()", "CreatorOnly()", "AdminOnly()", "OwnerOnly()", "ProtocolOnly()",
  "InvalidCaller(address)", "InvalidCaller()", "Unapproved(address)", "Blocked(address)",
  "Blacklisted(address)", "IsBlacklisted()", "BotDetected()", "AntiBot()",
];

for (const t of [target1, target2]) {
  const hits = NAMES.filter((n) => keccak256(toHex(n)) === t);
  console.log(t, "->", hits.length ? hits.join(", ") : "(no match in wordlist)");
}
