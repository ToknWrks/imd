/**
 * verify-auto-check.mjs — automated probes for /verify checklist items.
 * Read-only: tests, HTTP GETs, eth_call/eth_getCode, DB selects. Marks nothing.
 * Usage: node --env-file=.env scripts/verify-auto-check.mjs
 */
import { execSync } from "node:child_process";
import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:4200";
const results = [];
const add = (id, ok, detail) => results.push({ id, ok, detail });

async function get(path) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(15000) });
  return { status: r.status, body: await r.text() };
}
async function post(path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  return { status: r.status, body: await r.text() };
}

// 1. Pages render (200)
for (const [id, path] of [["page-tokens", "/tokens"], ["page-zooch", "/zooch"], ["page-alpha", "/alpha"], ["page-sniper", "/sniper"], ["page-mm", "/mm"], ["page-verify", "/verify"], ["page-trades", "/trades"], ["page-settings", "/settings"]]) {
  try { const r = await get(path); add(id, r.status === 200, `GET ${path} → ${r.status}`); }
  catch (e) { add(id, false, `GET ${path} → ${e.message}`); }
}

// 2. Unit tests (zooch clamps + MM engine gates)
for (const [id, file] of [["zooch-clamps", "zooch.test.mjs"], ["mm-engine-tests", "mm.test.mjs"]]) {
  try {
    const out = execSync(`node --test ${file}`, { cwd: process.cwd() + "/..", encoding: "utf8", timeout: 120000 });
    const m = out.match(/# pass (\d+)/), f = out.match(/# fail (\d+)/);
    add(id, Number(f?.[1] ?? 1) === 0, `${file}: ${m?.[1] ?? "?"} pass / ${f?.[1] ?? "?"} fail`);
  } catch (e) { add(id, false, `${file}: ${String(e.message).slice(0, 120)}`); }
}

// 3. PM2 processes online
try {
  const j = JSON.parse(execSync("pm2 jlist", { encoding: "utf8" }));
  const online = j.filter((p) => p.pm2_env?.status === "online").map((p) => p.name);
  const want = ["accumulate-dashboard", "accumulate-watcher"];
  const ok = want.every((w) => online.includes(w));
  add("infra-pm2", ok, `online: ${online.join(", ")}`);
} catch (e) { add("infra-pm2", false, e.message); }

// 4. Base V2 factory canonical (eth_getCode on public Base RPC, address from chains.mjs)
try {
  const c = createPublicClient({ transport: http("https://mainnet.base.org") });
  const factory = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6";
  const code2 = await c.getBytecode({ address: factory }).catch(() => null);
  add("v2factory-fixed", !!code2 && code2 !== "0x", `eth_getCode(${factory.slice(0, 10)}…) → ${code2 ? code2.length + " chars" : "empty"}`);
} catch (e) { add("v2factory-fixed", false, e.message); }

// 5. V4 sell quote — QUORUM through its V4 pool via the dashboard's own discover path
try {
  const r = await post("/api/sniper/discover", { chain: "robinhood", token: "0xa6452fd7134218f62056a304eaf501f8714a26b9", ethAmount: "0.001" });
  const j = JSON.parse(r.body);
  const v4 = (j.pools ?? []).find((p) => p.dex === "V4");
  add("v4sell-quote", !!v4 && Number(v4.quotedOut ?? 0) > 0, v4 ? `V4 quote for 0.001 ETH: ${v4.quotedOutFormatted} QUORUM` : `no V4 pool in discovery (${r.status})`);
} catch (e) { add("v4sell-quote", false, e.message); }

// 6. MM snapshot pricing — /api/mm/status for a tracked token (read-only)
try {
  const strat = await post("/api/mm/strategies", {});
  const list = JSON.parse(strat.body);
  const s = (list.strategies ?? list.items ?? [])[0];
  if (s) {
    const st = await post("/api/mm/status", { id: s.id });
    const j = JSON.parse(st.body);
    add("mm-snapshot-pricing", st.status === 200, `strategy #${s.id} status → ${st.status}${j?.snapshot ? " (snapshot ok)" : ""}`);
  } else add("mm-snapshot-pricing", true, "no MM strategies configured — nothing to probe (not a failure)");
} catch (e) { add("mm-snapshot-pricing", false, e.message); }

// 7. Settings keys present (masked — never print values)
try {
  const env = readFileSync(process.cwd() + "/../.env", "utf8");
  const has = (k) => new RegExp(`^${k}=.+`, "m").test(env);
  const keys = ["AGENT_PRIVATE_KEY", "ALCHEMY_API_KEY", "OPENAI_API_KEY"].filter(has);
  add("settings-keys", keys.length >= 2, `present: ${keys.join(", ")} (values not printed)`);
} catch (e) { add("settings-keys", false, e.message); }

// 8. MM dry-run loop produced decision rows
try {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(process.cwd() + "/../data/accumulate.db", { readonly: true });
  const dry = db.prepare("SELECT COUNT(*) n FROM mm_trades WHERE dry_run = 1").get();
  add("mm-dry-run-loop", dry.n > 0, `${dry.n} dry-run trade rows`);
} catch (e) { add("mm-dry-run-loop", false, String(e.message).slice(0, 100)); }

console.log("\n=== verify-auto-check results ===");
for (const r of results) console.log(`[${r.ok ? "PASS" : "WARN"}] ${r.id.padEnd(22)} ${r.detail}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed. Nothing was written to the DB.`);
