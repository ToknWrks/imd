/**
 * icons.mjs — token & chain icon resolution with on-disk caching.
 *
 * Sources, in order:
 *   1. Local cache  data/icons/<key>.<ext>  (survives restarts, zero rate limit)
 *   2. Trust Wallet assets repo (github raw) — checksummed address per chain,
 *      plus per-chain info/logo.png for chain icons (ethereum, base)
 *   3. Dexscreener token-pairs API — info.imageUrl for DEX-traded tokens on
 *     ANY chain incl. Robinhood (fresh launchpad tokens usually have a logo
 *     there because the pair page carries it). Same API findBestV4Pool uses.
 *   4. Generated SVG badge (address-hashed hue + symbol initials) so the UI
 *      never shows a broken image — badge results are NOT cached, so a token
 *      that later gets a logo picks it up automatically.
 *
 * Served by dashboard.mjs at GET /api/icon/...
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getAddress } from "viem";
import { getChain } from "./chains.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, "data", "icons");
const TRUST_URL = "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains";
const DEXSCREENER_PAIRS = (chain, address) => `https://api.dexscreener.com/token-pairs/v1/${chain}/${address}`;

/** trustwallet blockchain slug per chainKey (null = no upstream logos). */
const CHAIN_SLUG = { ethereum: "ethereum", base: "base", robinhood: null };

// Static per-chain-key token logo overrides — for assets no DEX indexes with
// a logo (e.g. USDG, a quote-currency stable that appears as the quote side
// of every pair, so Dexscreener's pair payloads never attach info.imageUrl).
// Checked after cache, before Trust Wallet. Keyed by chainKey:address-lc.
const TOKEN_OVERRIDES = {
  // USDG (Global Dollar) — CoinGecko
  "robinhood:0x5fc5360d0400a0fd4f2af552add042d716f1d168": "https://coin-images.coingecko.com/coins/images/51281/large/GDN_USDG_Token_200x200.png",
};

// Per-token in-memory TTL cache for the Dexscreener pairs lookup — the same
// endpoint findBestV4Pool hits; don't hammer it per icon request.
const _dexCache = new Map(); // `${chain}:${addr-lc}` → { url, at }
const DEX_TTL_MS = 10 * 60_000;

function cacheFile(name) { return resolve(CACHE_DIR, name); }

async function fetchIcon(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 200 ? { data: buf, contentType: type } : null;
  } catch { return null; }
}

/** Dexscreener logo URL for a token (cached in-memory, null on miss). */
async function dexscreenerLogoUrl(chainKey, addressLc) {
  const dep = getChain(chainKey); // throws on unknown chain
  const key = `${chainKey}:${addressLc}`;
  const cached = _dexCache.get(key);
  if (cached && Date.now() - cached.at < DEX_TTL_MS) return cached.url;
  let url = null;
  try {
    const res = await fetch(DEXSCREENER_PAIRS(dep.dexscreener, addressLc), { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const pairs = await res.json();
      // Pairs come sorted by liquidity; take the first that has any image.
      url = (Array.isArray(pairs) ? pairs : []).find((p) => p.info?.imageUrl)?.info?.imageUrl ?? null;
    }
  } catch { /* fall through */ }
  _dexCache.set(key, { url, at: Date.now() });
  return url;
}

/** Deterministic SVG badge: address-hashed hue + symbol initials. */
function svgBadge(address, symbol) {
  const sym = String(symbol ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "?";
  let h = 0;
  const seed = String(address ?? "?");
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="6" fill="hsl(${hue},42%,22%)"/>` +
    `<rect width="60" height="60" x="2" y="2" rx="5" fill="none" stroke="hsl(${hue},55%,38%)" stroke-width="2"/>` +
    `<text x="32" y="39" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="${sym.length > 2 ? 20 : 24}" font-weight="700" fill="hsl(${hue},70%,72%)">${sym}</text></svg>`;
  return { data: Buffer.from(svg), contentType: "image/svg+xml" };
}

function readCached(name) {
  const p = cacheFile(name);
  if (!existsSync(p)) return null;
  const data = readFileSync(p);
  const contentType = name.endsWith(".svg") ? "image/svg+xml"
    : name.endsWith(".png") ? "image/png"
    : name.endsWith(".jpg") ? "image/jpeg"
    : name.endsWith(".webp") ? "image/webp"
    : "application/octet-stream";
  return { data, contentType };
}

function extFor(contentType) {
  if (contentType.includes("svg")) return "svg";
  if (contentType.includes("jpeg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  return "png";
}

function storeCache(name, icon) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cacheFile(`${name}.${extFor(icon.contentType)}`), icon.data);
  } catch { /* cache is best-effort */ }
}

/** Robinhood Chain logo — no upstream source exists (Trust Wallet has no
 *  slug for it), so we render the house style: red gradient disc + feather. */
function robinhoodChainLogo() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#e8453c"/><stop offset="1" stop-color="#a41e1e"/></linearGradient></defs>` +
    `<circle cx="32" cy="32" r="30" fill="url(#g)"/>` +
    `<path d="M44 17c-9 1-17 6-21 13-3 5-4 11-3 17l3-2c1-5 3-9 6-15 2-4 6-8 10-10-3 3-6 8-8 12-2 5-3 9-3 13l3-1c1-3 2-6 4-10 2-5 6-10 9-13 2-2 5-3 6-4z" fill="#fff"/>` +
    `</svg>`;
  return { data: Buffer.from(svg), contentType: "image/svg+xml" };
}

/**
 * Resolve an icon to { data, contentType } — never throws.
 * kind: "token" (chainKey + contract address) | "chain" (chainKey)
 */
export async function getIcon(kind, chainKey, address, symbol) {
  try {
    if (kind === "chain") {
      const name = `chain-${chainKey}`;
      const cached = readCached(name);
      if (cached) return cached;
      const slug = CHAIN_SLUG[chainKey];
      if (!slug) {
        const logo = chainKey === "robinhood" ? robinhoodChainLogo() : null;
        if (logo) { storeCache(name, logo); return logo; }
        return svgBadge(chainKey, chainKey.slice(0, 2));
      }
      const icon = await fetchIcon(`${TRUST_URL}/${slug}/info/logo.png`);
      if (!icon) return svgBadge(chainKey, chainKey.slice(0, 2));
      storeCache(name, icon);
      return icon;
    }

    // token icon
    const addressLc = String(address ?? "").toLowerCase();
    getChain(chainKey); // throws on unknown chain → caught → badge fallback
    const name = `token-${chainKey}-${addressLc}`;
    const cached = readCached(name);
    if (cached) return cached;
    const slug = CHAIN_SLUG[chainKey];
    let icon = null;
    if (slug) {
      const checksummed = getAddress(address); // trustwallet keys are checksummed
      icon = await fetchIcon(`${TRUST_URL}/${slug}/assets/${checksummed}/logo.png`);
    }
    if (!icon) icon = await fetchIcon(TOKEN_OVERRIDES[`${chainKey}:${addressLc}`] ?? "");
    if (!icon) {
      const url = await dexscreenerLogoUrl(chainKey, addressLc);
      if (url) icon = await fetchIcon(url);
    }
    if (!icon) return svgBadge(address, symbol);
    storeCache(name, icon);
    return icon;
  } catch {
    return svgBadge(address ?? chainKey ?? "?", symbol);
  }
}

/** URL helpers for templates/client JS. */
export function tokenIconUrl(chainKey, address, symbol) {
  return `/api/icon/token/${encodeURIComponent(chainKey)}/${address}?s=${encodeURIComponent(symbol ?? "")}`;
}
export function chainIconUrl(chainKey) {
  return `/api/icon/chain/${encodeURIComponent(chainKey)}`;
}
