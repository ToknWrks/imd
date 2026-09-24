/**
 * repair-sniper-ledger.mjs — re-derive a user's sniper_trades rows for ONE token
 * from on-chain truth, and print (or --apply) the corrections.
 *
 * Fixes the four ledger bugs found 2026-09-24 in existing rows:
 *   1. REVERTED smart-wallet ops recorded as ok trades   → status='error'
 *   2. V4 sell proceeds decoded as the TOKEN quantity    → real ETH received
 *   3. Transfers between the user's own wallets as trades → status='transfer'
 *   4. SCW buys/sells with NULL cost/proceeds            → ETH from internal transfers
 *
 * Usage (run on the VPS — it reads/writes that box's data/accumulate.db):
 *   node --env-file=.env scripts/repair-sniper-ledger.mjs <userId> <token> [--apply]
 * Dry-run by default. --apply backs up nothing itself — back up data/ first.
 */
import Database from "better-sqlite3";
import { createPublicClient, http, getAddress, parseAbi, decodeEventLog } from "viem";
import { mainnet } from "viem/chains";
import { resolveUserReadWallets } from "../smart-wallet-api.mjs";

const [userId, token, flag] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{40}$/.test(userId || "") || !/^0x[0-9a-fA-F]{40}$/.test(token || "")) {
  console.error("usage: node --env-file=.env scripts/repair-sniper-ledger.mjs <userId> <token> [--apply]");
  process.exit(1);
}
const APPLY = flag === "--apply";
const KEY = process.env.ALCHEMY_API_KEY?.trim();
const URL = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;
const c = createPublicClient({ chain: mainnet, transport: http(URL, { batch: false, retryCount: 2 }) });
const tokenLc = token.toLowerCase();
const wallets = (await resolveUserReadWallets(userId, "ethereum")).map((a) => a.toLowerCase());
const own = new Set(wallets);
const USER_OP_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function transfers(params) {
  let out = [], pageKey;
  do {
    const r = await (await fetch(URL, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ fromBlock: "0x0", toBlock: "latest", maxCount: "0x3e8", ...params, ...(pageKey ? { pageKey } : {}) }] }) })).json();
    if (r.error) throw new Error(r.error.message);
    out = out.concat(r.result.transfers); pageKey = r.result.pageKey;
  } while (pageKey);
  return out;
}
// Native ETH legs per tx across the user's wallets (external + internal).
const native = new Map();
for (const w of wallets) for (const dir of ["fromAddress", "toAddress"]) {
  for (const t of await transfers({ category: ["external", "internal"], [dir]: w })) {
    if (own.has(String(t.from).toLowerCase()) && own.has(String(t.to).toLowerCase())) continue; // own↔own
    const e = native.get(t.hash) ?? { out: 0, in: 0 };
    if (dir === "fromAddress") e.out += Number(t.value ?? 0); else e.in += Number(t.value ?? 0);
    native.set(t.hash, e);
  }
}

async function analyze(hash) {
  const rc = await c.getTransactionReceipt({ hash });
  // 1. UserOperation success for any of the user's wallets
  const uo = rc.logs.find((l) => l.topics[0] === USER_OP_EVENT && own.has("0x" + String(l.topics[2]).slice(26).toLowerCase()));
  const uoFailed = uo ? BigInt("0x" + uo.data.slice(66, 130)) !== 1n : false;
  // 1b. Plain (non-UserOperation) tx that reverted on-chain — e.g. DIRECT SIGN
  // from the owner EOA. No logs, nothing moved (VANGUARD #72/#73).
  const txReverted = rc.status !== "success";
  // 3. token Transfer logs touching the user's wallets
  const tok = rc.logs.filter((l) => l.address.toLowerCase() === tokenLc && l.topics[0] === TRANSFER)
    .map((l) => ({ from: "0x" + l.topics[1].slice(26).toLowerCase(), to: "0x" + l.topics[2].slice(26).toLowerCase(), v: BigInt(l.data) }))
    .filter((t) => own.has(t.from) || own.has(t.to));
  const selfTransfer = tok.length > 0 && tok.every((t) => own.has(t.from) && own.has(t.to));
  let net = 0n;
  for (const t of tok) { if (own.has(t.to)) net += t.v; if (own.has(t.from)) net -= t.v; }
  const leg = native.get(hash) ?? { out: 0, in: 0 };
  return { uoFailed, txReverted, selfTransfer, netToken: Number(net) / 1e18, ethIn: leg.in - leg.out, ethOut: leg.out - leg.in };
}

const db = new Database("data/accumulate.db", { readonly: !APPLY });
const rows = db.prepare(`SELECT * FROM sniper_trades WHERE lower(contract_address) = ? AND (user_id = ? OR user_id IS NULL) AND buy_tx_hash IS NOT NULL ORDER BY id`).all(tokenLc, userId.toLowerCase());
const fixes = [];
for (const r of rows) {
  if (r.status !== "ok") continue;
  let a;
  try { a = await analyze(r.buy_tx_hash); } catch (e) { console.log(`#${r.id} ${r.buy_tx_hash.slice(0, 10)} analyze failed: ${e.message}`); continue; }
  const isSellRow = /^(SELL|PROBE|AUTOSELL)/.test(String(r.dex || "")) || /\(sell\)/i.test(String(r.dex || ""));
  const f = { id: r.id, tx: r.buy_tx_hash.slice(0, 12), dex: r.dex, before: { status: r.status, eth_spent: r.eth_spent, eth_received: r.eth_received, token_amount: r.token_amount } };
  if (a.uoFailed) f.after = { status: "error", eth_received: null, error: "smart-wallet UserOperation reverted on-chain (repair 2026-09-24)" };
  else if (a.txReverted) f.after = { status: "error", eth_received: null, error: "transaction reverted on-chain — nothing traded (repair 2026-09-24)" };
  else if (a.selfTransfer) f.after = { status: "transfer", error: "move between the user's own wallets — not a trade (repair 2026-09-24)" };
  else {
    const after = {};
    if (isSellRow && a.netToken < 0 && a.ethIn > 0 && Math.abs((r.eth_received ?? -1) - a.ethIn) > 1e-12) after.eth_received = a.ethIn;
    if (!isSellRow && a.netToken > 0 && a.ethOut > 0 && (r.eth_spent == null || Math.abs(r.eth_spent - a.ethOut) > 1e-12)) after.eth_spent = a.ethOut;
    // Missing token quantity on a successful trade → fill from the Transfer logs.
    if (r.token_amount == null && a.netToken !== 0) after.token_amount = Math.abs(a.netToken);
    if (Object.keys(after).length) f.after = after;
  }
  if (f.after) fixes.push(f);
}
for (const f of fixes) console.log(`#${f.id} ${f.tx} [${f.dex}]\n    before ${JSON.stringify(f.before)}\n    after  ${JSON.stringify(f.after)}`);
console.log(`\n${fixes.length} row(s) to correct out of ${rows.length} for ${tokenLc} / ${userId}`);
if (APPLY && fixes.length) {
  const tx = db.transaction(() => {
    for (const f of fixes) {
      const sets = Object.keys(f.after).map((k) => `${k} = @${k}`).join(", ");
      db.prepare(`UPDATE sniper_trades SET ${sets} WHERE id = @id`).run({ ...f.after, id: f.id });
    }
  });
  tx();
  console.log("APPLIED.");
} else if (!APPLY) console.log("dry run — nothing written. Re-run with --apply to write.");
