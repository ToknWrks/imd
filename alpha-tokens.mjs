/**
 * alpha-tokens.mjs — the Alpha-list token registry file.
 *
 * Maintains data/alpha-tokens.json: every launchpad token contract the Alpha
 * engine has ever seen (address + symbol + decimals). The wallet slideout
 * scans these on every open so ANY alpha token the wallet holds displays
 * automatically — no watcher setup required (2026-09-21 UX request).
 *
 * Design:
 *  - recordAlphaTokens(rows): merge the alpha queue's current roster into the
 *    file (add-only; symbols update, never remove — a coin that drops off the
 *    scored queue may still sit in someone's wallet).
 *  - getAlphaTokens(): the full registry from the file.
 *  - fillDecimals(): decimals() is not in the indexer payload — read once
 *    per token via Multicall3 and persist (curve coins are 18 in practice,
 *    but never trust a launchpad's token contract more than the chain).
 *  - scanAlphaBalances(wallets): Multicall balanceOf for every registry
 *    token across the given wallets; returns { address -> {owner, scw} raw }.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { getChain } from "./chains.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_FILE = resolve(__dirname, "data", "alpha-tokens.json");

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
// Multicall3 (canonical, deployed on mainnet + Base + 4663 at the same address)
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_ABI = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) returns ((bool success, bytes returnData)[] returnData)",
]);
const CHUNK = 120; // calls per multicall batch (3 calls/token × 40 tokens)

let _registry = null;          // Map<addrLower, {address, symbol, decimals, name}>
let _decimalsPending = new Set();
let _balanceCache = new Map(); // cacheKey -> { at, balances } (30s TTL)

function load() {
  if (_registry) return _registry;
  _registry = new Map();
  try {
    if (existsSync(REGISTRY_FILE)) {
      const raw = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
      for (const t of raw.tokens || []) {
        if (/^0x[0-9a-fA-F]{40}$/.test(t.address || "")) {
          _registry.set(t.address.toLowerCase(), { ...t, address: getAddress(t.address) });
        }
      }
    }
  } catch (e) {
    console.error(`[alpha-tokens] load failed: ${e.message}`);
  }
  return _registry;
}

function save() {
  try {
    mkdirSync(resolve(__dirname, "data"), { recursive: true });
    const tmp = REGISTRY_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify({ tokens: [..._registry.values()], updatedAt: new Date().toISOString() }, null, 0));
    renameSync(tmp, REGISTRY_FILE);
  } catch (e) {
    console.error(`[alpha-tokens] save failed: ${e.message}`);
  }
}

/** Merge alpha-queue rows (address/symbol) into the registry. Add-only. */
export function recordAlphaTokens(rows = []) {
  const reg = load();
  let added = 0, updated = 0;
  for (const r of rows) {
    if (!r?.address || !/^0x[0-9a-fA-F]{40}$/.test(r.address)) continue;
    const key = r.address.toLowerCase();
    const prev = reg.get(key);
    if (!prev) { added++; reg.set(key, { address: getAddress(r.address), symbol: r.symbol || null, decimals: null, name: r.name || null }); }
    else if (r.symbol && r.symbol !== prev.symbol) { updated++; prev.symbol = r.symbol; }
  }
  if (added || updated) {
    save();
    console.log(`[alpha-tokens] registry: +${added} new, ${updated} symbol updates (${reg.size} total)`);
  }
  return reg.size;
}

/** The full registry as an array. */
export function getAlphaTokens() {
  return [...load().values()];
}

function publicClientFor(chainKey = "ethereum") {
  const dep = getChain(chainKey);
  return createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc()) });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Fill missing decimals() on-chain via Multicall3 (one-time per token). */
export async function fillAlphaDecimals(chainKey = "ethereum") {
  const reg = load();
  const missing = [...reg.values()].filter((t) => t.decimals == null).map((t) => t.address);
  if (!missing.length) return;
  const pub = publicClientFor(chainKey);
  for (const batch of chunk(missing, CHUNK)) {
    try {
      const res = await pub.readContract({
        address: MULTICALL3, abi: MULTICALL3_ABI, functionName: "aggregate3",
        args: [batch.map((addr) => ({ target: getAddress(addr), allowFailure: true, callData: encodeDecimals() }))],
      });
      res.forEach((r, i) => {
        if (r.success && r.returnData && r.returnData !== "0x") {
          try { reg.get(batch[i].toLowerCase()).decimals = Number(BigInt(r.returnData)); } catch {}
        }
      });
    } catch (e) {
      console.error(`[alpha-tokens] decimals multicall failed (${batch.length} tokens): ${String(e.message).slice(0, 80)}`);
      break; // keep nulls — caller falls back to 18
    }
  }
  save();

  function encodeDecimals() {
    // decimals() selector — precomputed once
    return "0x313ce567";
  }
}

/**
 * balanceOf every registry token across every wallet, via Multicall3.
 * Returns Map<tokenAddrLower, bigint[]> (one raw balance per wallet, same order).
 */
export async function scanAlphaBalances(wallets, chainKey = "ethereum", { ttlMs = 30_000 } = {}) {
  const reg = load();
  const cacheKey = chainKey + ":" + wallets.map((w) => w.toLowerCase()).join(",") + ":" + reg.size;
  const hit = _balanceCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ttlMs) return hit.balances;

  const addresses = [...reg.keys()];
  const balances = new Map();
  if (!addresses.length || !wallets?.length) return balances;
  const pub = publicClientFor(chainKey);

  // calls: for each token × wallet → balanceOf(wallet)
  const calls = [];
  for (const a of addresses) for (const w of wallets) calls.push({ target: getAddress(a), wallet: w });
  const results = new Array(calls.length);
  for (const batch of chunk(calls, CHUNK)) {
    try {
      const res = await pub.readContract({
        address: MULTICALL3, abi: MULTICALL3_ABI, functionName: "aggregate3",
        args: [batch.map((c) => ({ target: c.target, allowFailure: true, callData: encodeBalanceOf(c.wallet) }))],
      });
      res.forEach((r, i) => {
        const idx = calls.indexOf(batch[i]);
        try { results[idx] = r.success && r.returnData && r.returnData !== "0x" ? BigInt(r.returnData) : 0n; }
        catch { results[idx] = 0n; }
      });
    } catch (e) {
      console.error(`[alpha-tokens] balance multicall failed (${batch.length} calls): ${String(e.message).slice(0, 80)}`);
      return balances; // empty scan on failure — never block the wallet UI
    }
  }
  // regroup: per token, list of raw balances (wallet order)
  addresses.forEach((a, ai) => {
    const per = [];
    for (let wi = 0; wi < wallets.length; wi++) per.push(results[ai * wallets.length + wi] ?? 0n);
    balances.set(a, per);
  });
  _balanceCache.set(cacheKey, { at: Date.now(), balances });
  return balances;
}

function encodeBalanceOf(addr) {
  // balanceOf(address) selector + padded address
  const clean = String(addr).replace(/^0x/, "").toLowerCase().padStart(64, "0");
  return "0x70a08231" + clean;
}
