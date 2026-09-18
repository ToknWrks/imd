/**
 * mark-verify.mjs — gather evidence from this session's work and mark the
 * /verify checklist items it genuinely verified. Only marks checks with
 * concrete evidence (DB rows, test runs, on-chain reads, live sales).
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

for (const line of readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

// 1) Exit rows in dip_trades (evidence: #tokens-exit, #trades-render)
const db = await import("../db.mjs");
const trades = db.getDipTrades(500);
const exits = trades.filter((t) => t.execution_kind === "exit");
console.log(`evidence: ${exits.length} exit row(s) in dip_trades`);
for (const t of exits.slice(0, 8)) {
  console.log(`  #${t.id} ${t.status} amount=${t.token_amount} tx=${(t.sell_tx_hash ?? "").slice(0, 14)} err=${(t.error ?? "").slice(0, 60)}`);
}

// 2) Watcher balances moved post-sale (evidence: #tokens-refresh)
const watchers = db.getDipWatchers();
for (const w of watchers) {
  if (w.wallet_balance && w.position_updated_at) {
    console.log(`evidence: ${w.symbol} balance=${Number(w.wallet_balance).toFixed(4)} updated=${w.position_updated_at}`);
  }
}

// 3) Base V2 factory has code (evidence: #v2factory-fixed)
const { createPublicClient, http } = await import("viem");
const { getChain } = await import("../chains.mjs");
const base = getChain("base");
const code = await createPublicClient({ transport: http(base.httpRpc()) })
  .request({ method: "eth_getCode", params: [base.v3.v2Factory, "latest"] });
console.log(`evidence: Base V2 factory ${base.v3.v2Factory} code size = ${(code.length - 2) / 2} bytes ${code.length > 2 ? "✓" : "✗ NO CODE"}`);

// 4) MM engine tests (evidence: #mm-engine-tests) — run via child process below by caller
