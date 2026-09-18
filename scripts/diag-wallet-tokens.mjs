#!/usr/bin/env node
// diag-wallet-tokens.mjs — verify wallet-slideout.js + wallet-api.mjs load
// cleanly and that /api/wallet now returns watched tokens (via live fetch).
import { walletSlideoutHtml, WALLET_SLIDEOUT_CSS } from "../wallet-slideout.js";
import * as api from "../wallet-api.mjs";

console.log("✅ wallet-slideout.js loads, html length:", walletSlideoutHtml().length);
console.log("✅ wallet-api.mjs loads, exports:", Object.keys(api).join(", "));

// live: hit the running dashboard's wallet endpoint
try {
  const r = await fetch("http://localhost:4200/api/wallet");
  const j = await r.json();
  console.log("\n/api/wallet status:", r.status, "ok:", j.ok);
  if (j.ok) {
    console.log("tokens in response:", (j.tokens || []).length);
    for (const t of j.tokens || []) {
      console.log(`  ${t.symbol} (${t.chainName}): ${t.balance} · $${t.balanceUsd ?? "—"} · price $${t.priceUsd ?? "—"} · P/L ${t.unrealizedPlUsd ?? "—"}`);
    }
    console.log("totalUsd:", j.totalUsd);
  } else {
    console.log("error:", j.error);
  }
} catch (e) {
  console.log("live fetch failed:", e.message);
}
