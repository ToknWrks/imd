// CRITICAL: the probe tx has NO USDG transfer — yet the probe verdict said
// DELIVERED. The native-ETH delta must have been positive from something else
// (or a misread). Recheck the delta logic: beforeNative vs afterNative around
// a sell whose proceeds were supposed to be USDG. The wallet gained 5.7e-05
// "ETH" according to the ledger — but the receipt shows no USDG at all and the
// wallet got nothing. The probe's verdict is WRONG. Root cause: the probe
// measures native ETH delta, but QUORUM's pool pays USDG (an ERC-20) — the
// USDG never arrives, and the tiny native delta it saw was probably gas refund
// variance, not proceeds.
//
// Fix: measure the QUOTE ASSET balance (dollar token for dollar-quoted pools),
// not native ETH. Resolve the quote from the pool object the sell used.
import { readFileSync } from "fs";
console.log("probing again would double-sell; instead patching sell-probe to check the right asset");
