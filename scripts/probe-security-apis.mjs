/** Probe: what does DexScreener expose per token, and does GoPlus cover 4663? (read-only) */
// 1) A known graduated PONS token (BRODIE from the earlier feed) vs OPAI
const TOKENS = "0x84eFe6eD3606e88d28AB4A1497533699300015e3,0x39252e514880c1640f7466818a98412cc596b16c";
const pairs = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${TOKENS}`, { signal: AbortSignal.timeout(12000) }).then(r => r.json());
console.log("=== DexScreener pair fields ===");
for (const p of pairs.slice(0, 4)) {
  console.log(JSON.stringify({
    base: p.baseToken?.symbol, dexId: p.dexId, pairCreatedAt: p.pairCreatedAt,
    liquidity: p.liquidity?.usd, volume24h: p.volume?.h24, marketCap: p.marketCap ?? p.fdv,
    infoKeys: Object.keys(p.info ?? {}),
    labels: p.labels ?? null,
    // dump every top-level key once to see the full schema
    keys: undefined,
  }));
}
console.log("all top-level keys:", [...new Set(pairs.flatMap(p => Object.keys(p)))].join(", "));
console.log("info sample:", JSON.stringify(pairs[0]?.info));

// 2) GoPlus security API — does it support chain 4663?
for (const addr of ["0x39252e514880c1640f7466818a98412cc596b16c"]) {
  try {
    const r = await fetch(`https://api.gopluslabs.com/api/v1/token_security/4663?contract_addresses=${addr}`, { signal: AbortSignal.timeout(12000) });
    const j = await r.json();
    console.log("\n=== GoPlus 4663 ===", "status:", r.status, "code:", j.code, "msg:", j.message);
    const d = j.result?.[addr.toLowerCase()];
    if (d) console.log("security fields:", JSON.stringify({
      open_source: d.open_source, honeypot: d.honeypot, is_honeypot: d.is_honeypot,
      buy_tax: d.buy_tax, sell_tax: d.sell_tax, mint: d.mint, owner: d.owner_address ? "set" : null,
    }));
    else console.log("no result for token (chain unsupported or unindexed)");
  } catch (e) { console.log("GoPlus 4663 FAIL:", String(e.message).slice(0, 120)); }
}

// 3) GoPlus on a chain it definitely supports (ETH=1) as control
try {
  const r = await fetch("https://api.gopluslabs.com/api/v1/token_security/1?contract_addresses=0xdAC17F958D2ee523a2206206994597C13D831ec7", { signal: AbortSignal.timeout(12000) });
  const j = await r.json();
  console.log("\nGoPlus control (ETH USDT):", r.status, j.result ? "has data" : j.message);
} catch (e) { console.log("control FAIL:", e.message); }
