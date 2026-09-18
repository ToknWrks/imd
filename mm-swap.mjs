/**
 * mm-swap.mjs — venue resolution, live quoting, and buy/sell execution for
 * the /mm tab. Composes the battle-tested dip-swap.mjs primitives:
 *   - findBestV4Pool (Dexscreener + on-chain verify + poolKey recovery)
 *   - buyDip (ETH pools) / buyDipWithDollar (dollar pools) — verified paths
 *   - the Universal Router path shape from dip-swap (works on hooked pools)
 * Plus a generic ERC-20-quoted leg for pools like ATLANTIS/MU where the quote
 * asset is a stock token (neither ETH nor USDG).
 *
 * Everything is read-only unless a function with `dryRun` is called with
 * dryRun: false, or an execute* function is invoked (they always trade).
 */
import { getAddress, parseAbi, parseAbiParameters, encodeAbiParameters } from "viem";
import { getChain, httpClient, getEthUsdPriceFor, STATE_VIEW_ABI } from "./chains.mjs";
import {
  findBestV4Pool, resolvePoolOverride, getTokenMeta, getErc20Balance,
  getV4SpotPriceEth, getV4SpotPriceUsd, quoteBuyV4, quoteSellV4,
  buyDip, buyDipWithDollar, derivePoolId,
  findBestV3DollarPool, getV3DollarSpotPriceUsd,
} from "./dip-swap.mjs";
import { classifyVenue } from "./mm-engine.mjs";
import { recordGasForTx } from "./gas-ledger.mjs";

const ETH_ADDRESS = "0x0000000000000000000000000000000000000000";
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const PERMIT2_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const V4_QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint256 exactAmount, bytes hookData) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const V3_SLOT0_ABI = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality)"]);
const V3_QUOTER_PATH_ABI = parseAbi(["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint256[] amounts)"]);
const UR_EXECUTE_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

// ── venue resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the MM venue for a token. Honors venue_override (a V4 poolId) via
 * resolvePoolOverride, else findBestV4Pool. Returns { venue, meta, cls }.
 */
export async function resolveMmVenue(tokenAddress, chainKey, venueOverride = null) {
  const token = getAddress(tokenAddress);
  const venue = venueOverride
    ? await resolvePoolOverride(token, venueOverride, chainKey)
    : await findBestV4Pool(token, chainKey);
  if (!venue) throw new Error(`no V4 pool found for ${token} on ${chainKey} — paste the poolId or V3 pool address as the venue override`);
  const meta = await getTokenMeta(token, chainKey);
  if (venue.kind === "v3") {
    // V3 pool override (e.g. IF/USDG 0x39A2… — $8M+ depth vs IF's thin V4
    // pool). Normalize into the MM venue shape: a poolKey VIEW for the
    // classifier, plus the V3 fields the V3 execution branches read.
    const v = {
      kind: "v3",
      address: venue.address,
      token0: venue.token0,
      token1: venue.token1,
      fee: venue.fee,
      // poolKey view so classifyVenueForMm works unchanged
      poolKey: { currency0: venue.token0, currency1: venue.token1, fee: venue.fee, tickSpacing: 0, hooks: ETH_ADDRESS },
      poolId: null,
    };
    const cls = await classifyVenueForMmAsync(v, token, chainKey);
    return { venue: v, meta, cls };
  }
  const cls = await classifyVenueForMmAsync(venue, token, chainKey);
  return { venue, meta, cls };
}

/** Venue classification: which side is the token, what is the quote asset. */
export function classifyVenueForMm(venue, tokenAddress) {
  const token = getAddress(tokenAddress).toLowerCase();
  const c0 = getAddress(venue.poolKey.currency0).toLowerCase();
  const c1 = getAddress(venue.poolKey.currency1).toLowerCase();
  const tokenIs0 = c0 === token;
  const quote = tokenIs0 ? venue.poolKey.currency1 : venue.poolKey.currency0;
  const kind = getAddress(quote).toLowerCase() === ETH_ADDRESS ? "eth" : "erc20";
  // tokenAddress is consumed by quoteImpactPct's sell leg (the old shape
  // omitted it, so every sell-impact quote threw getAddress(undefined) and
  // was silently swallowed to 0 — engine traded blind on impact).
  return { tokenIs0, quote: getAddress(quote), kind, tokenAddress: getAddress(tokenAddress) };
}

/** Async venue classification: same as classifyVenueForMm plus the quote
 *  token's decimals. quoteImpactPct's BUY leg sizes its input with
 *  cls.quoteDecimals — without it a 6-dec dollar quote (USDG) was sized at
 *  18 decimals, sending 10^12× too much quote and reading −99.9% "impact"
 *  (IF/USDG, 2026-09-13). The sell leg already used getQuoteTokenDecimals,
 *  which is why sells priced fine while buys were fantasy. */
export async function classifyVenueForMmAsync(venue, tokenAddress, chainKey) {
  const cls = classifyVenueForMm(venue, tokenAddress);
  cls.quoteDecimals = cls.kind === "eth" ? 18 : await getQuoteTokenDecimals(cls.quote, chainKey);
  return cls;
}

// ── pricing ──────────────────────────────────────────────────────────────────

/**
 * Live snapshot: { priceUsd, ethUsd, quoteUsd, liquidityUsd, quoteSymbol }.
 * ETH-quoted pools price via slot0 + the chain's ETH/USD source.
 * ERC-20-quoted pools (e.g. ATLANTIS/MU) price the QUOTE token via its own
 * best ETH/USDG V4 pool (one level of recursion, cycle-guarded).
 */
export async function getMmSnapshot(venue, cls, tokenMeta, chainKey, _depth = 0) {
  const dep = getChain(chainKey);
  const ethUsd = await getEthUsdPriceFor(chainKey).catch(() => 0);

  if (cls.kind === "eth") {
    const ethPerToken = await getV4SpotPriceEth(venue, tokenMeta.decimals ?? 18, chainKey);
    const priceUsd = ethPerToken > 0 ? ethPerToken * ethUsd : 0;
    return {
      priceUsd, ethUsd, quoteUsd: ethUsd, quoteSymbol: "ETH",
      liquidityUsd: await dexscreenerPairLiquidity(venue, chainKey),
    };
  }

  // ERC-20-quoted pool: quotePerToken from slot0, then price the quote asset.
  const quotePerToken = await quotePerTokenFromSlot0(venue, cls, tokenMeta.decimals ?? 18, chainKey);
  const quoteMeta = _depth < 1 ? await getTokenMeta(cls.quote, chainKey).catch(() => ({ decimals: 18, symbol: "QUOTE" })) : { decimals: 18, symbol: "QUOTE" };
  let quoteUsd = 0;
  if (_depth < 1) {
    // Chain dollar token is the unit of account — $1 by definition, zero
    // lookups (this cost 2-3 Alchemy calls per strategy per poll before the
    // 2026-09-11 rate-limit incident).
    quoteUsd = getAddress(cls.quote).toLowerCase() === getAddress(dep.dollar).toLowerCase()
      ? 1
      : await getQuoteTokenUsd(cls.quote, chainKey);
  }
  const priceUsd = quotePerToken > 0 && quoteUsd > 0 ? quotePerToken * quoteUsd : 0;
  // DEBUG (temporary): expose the intermediates so a flapping price feed can
  // be attributed to quotePerToken vs quoteUsd from the daemon's own logs.
  console.log(`[mm-snapshot] pool=${(venue.poolId ?? "").slice(0, 10)}… quotePerToken=${quotePerToken.toExponential?.(6) ?? quotePerToken} quoteUsd=${quoteUsd} → priceUsd=${priceUsd}`);
  return {
    priceUsd, ethUsd, quoteUsd, quoteSymbol: quoteMeta?.symbol ?? "QUOTE",
    liquidityUsd: await dexscreenerPairLiquidity(venue, chainKey),
  };
}

/**
 * USD price of an arbitrary quote token (e.g. MU). V4-first (ETH or dollar
 * pool), then the V3 dollar-pool path (MU/USDG on 4663 is a V3 pool —
 * verified live 2026-09-10), then DexScreener's own price as evidence-grade
 * fallback (sizing only; execution min-outs always come from the real quoter).
 */
async function getQuoteTokenUsd(quoteAddress, chainKey) {
  const dep = getChain(chainKey);
  const quote = getAddress(quoteAddress);
  try {
    const qVenue = await findBestV4Pool(quote, chainKey);
    if (qVenue) {
      const qCls = classifyVenueForMm(qVenue, quote);
      if (qCls.kind === "eth") {
        const ethPerQuote = await getV4SpotPriceEth(qVenue, 18, chainKey);
        if (ethPerQuote > 0) return ethPerQuote * (await getEthUsdPriceFor(chainKey).catch(() => 0));
      } else if (getAddress(qCls.quote).toLowerCase() === getAddress(dep.dollar).toLowerCase()) {
        const p = await getV4SpotPriceUsd(qVenue, quote, 18, chainKey);
        if (p > 0) return p;
      }
    }
  } catch { /* fall through */ }
  try {
    const v3Pool = await findBestV3DollarPool(quote, chainKey);
    if (v3PoolUsable(v3Pool)) {
      const p = await getV3DollarSpotPriceUsd({ poolAddress: v3Pool.address, tokenIs0: v3Pool.tokenIs0, tokenDecimals: 18, chainKey });
      if (p > 0) return p;
    }
  } catch { /* fall through */ }
  try {
    const dep2 = getChain(chainKey);
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/${dep2.dexscreener}/${quote}`);
    const pairs = await res.json();
    // priceUsd on a pair is the BASE token's price. If our token is the quote
    // side, derive it: priceNative = base-per-quote, so quoteUsd = priceUsd /
    // priceNative. (Verified: MU's top-liquidity pairs are MOO/MU etc., where
    // grabbing priceUsd raw returned the memecoin's price — 2026-09-10.)
    let p = 0;
    for (const pair of (pairs ?? []).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))) {
      const base = pair?.baseToken?.address?.toLowerCase();
      const q = pair?.quoteToken?.address?.toLowerCase();
      const usd = Number(pair?.priceUsd ?? 0);
      const native = Number(pair?.priceNative ?? 0);
      if (usd <= 0) continue;
      if (q === quote.toLowerCase() && native > 0) { p = usd / native; break; }
      if (base === quote.toLowerCase()) { p = usd; break; }
    }
    if (p > 0) return p;
  } catch { /* give up */ }
  return 0;
}

function v3PoolUsable(pool) { return Boolean(pool?.address); }

/** slot0-derived quote-per-token ratio for an ERC-20-quoted pool. */
async function quotePerTokenFromSlot0(venue, cls, tokenDecimals, chainKey) {
  const dep = getChain(chainKey);
  let sqrtPriceX96;
  if (venue.kind === "v3") {
    // V3 pool contract: slot0's first word is the same sqrtPriceX96.
    const [sp] = await httpClient(chainKey).readContract({
      address: venue.address, abi: V3_SLOT0_ABI, functionName: "slot0",
    });
    sqrtPriceX96 = sp;
  } else {
    [sqrtPriceX96] = await httpClient(chainKey).readContract({
      address: dep.v4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [venue.poolId],
    });
  }
  const s = Number(sqrtPriceX96) / 2 ** 96;
  // Quote asset decimals matter: sqrtPriceX96 = sqrt(raw1/raw0)·2^96 is a RAW
  // ratio, so the whole-unit quote-per-token price must adjust for BOTH
  // sides' decimals. The old code only corrected the token side, pricing
  // USDG(6-dec)-quoted pools off by 10^12 (SIRIUS showed $1.05e-15 instead of
  // ~$0.001 — verified live 2026-09-10). token = currency0 → raw1/raw0 →
  // price = s² · 10^(tokenDec − quoteDec); token = currency1 → inverse.
  const quoteDecimals = await getQuoteTokenDecimals(cls.quote, chainKey);
  if (cls.tokenIs0) return s * s * 10 ** (Number(tokenDecimals) - Number(quoteDecimals));
  return s > 0 ? 10 ** (Number(quoteDecimals) - Number(tokenDecimals)) / (s * s) : 0;
}

/** Decimals of the quote token: chain registry when it's the chain dollar or
 *  WETH, else an on-chain decimals() read (cached per address). Exported for
 *  mm-watcher's Swap-log flow scanner. */
const _quoteDecimalsCache = new Map();
export async function getQuoteTokenDecimals(quoteAddress, chainKey) {
  const q = getAddress(quoteAddress).toLowerCase();
  const dep = getChain(chainKey);
  if (dep.dollar && q === getAddress(dep.dollar).toLowerCase()) return dep.dollarDecimals ?? 6;
  if (dep.weth && q === getAddress(dep.weth).toLowerCase()) return 18;
  if (_quoteDecimalsCache.has(q)) return _quoteDecimalsCache.get(q);
  let dec = 18;
  try {
    dec = await httpClient(chainKey).readContract({
      address: getAddress(quoteAddress),
      abi: parseAbi(["function decimals() view returns (uint8)"]),
      functionName: "decimals",
    });
  } catch { /* default 18 */ }
  _quoteDecimalsCache.set(q, dec);
  return dec;
}

async function dexscreenerPairLiquidity(venue, chainKey) {
  try {
    const dep = getChain(chainKey);
    // Look up the TOKEN side, not currency0: native-ETH V4 pools have
    // currency0 = 0x000…0, and DexScreener's token-pairs endpoint can't
    // resolve the zero address (IF/ETH read $0 liquidity on every tick,
    // 2026-09-11, while the pool really held ~$13.8k).
    const tokenSide = cls0IsToken(venue)
      ? venue.poolKey.currency0
      : venue.poolKey.currency1;
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/${dep.dexscreener}/${tokenSide}`);
    const pairs = await res.json();
    // V4 venues match by poolId; V3 venues have poolId=null and their
    // DexScreener pairAddress IS the pool contract address.
    const self = (venue.poolId ?? venue.address ?? "").toLowerCase();
    const match = (pairs ?? []).find((p) => (p.pairAddress ?? "").toLowerCase() === self);
    return match?.liquidity?.usd ?? 0;
  } catch {
    return 0;
  }
}

/** True when the pool's currency0 is a real (non-zero) address. */
function cls0IsToken(venue) {
  const c0 = (venue.poolKey?.currency0 ?? "").toLowerCase();
  return c0 !== "" && c0 !== ETH_ADDRESS;
}

// ── quoting (real quoter, never estimates) ───────────────────────────────────

/**
 * Quote tokens out for a BUY of `amountInRaw` of currencyIn (ETH zero-address
 * or ERC-20) through the venue. Returns amountOut (token raw).
 */
export async function quoteExactInOnVenue(venue, currencyIn, amountInRaw, chainKey) {
  // V3 venue: quote through QuoterV2 with the encoded path.
  if (venue.kind === "v3") {
    const dep = getChain(chainKey);
    const inIs0 = getAddress(currencyIn).toLowerCase() === getAddress(venue.token0).toLowerCase();
    const tokenIn = inIs0 ? venue.token0 : venue.token1;
    const tokenOut = inIs0 ? venue.token1 : venue.token0;
    const path = "0x" + getAddress(tokenIn).slice(2).toLowerCase()
      + Number(venue.fee).toString(16).padStart(6, "0")
      + getAddress(tokenOut).slice(2).toLowerCase();
    const { result } = await httpClient(chainKey).simulateContract({
      address: dep.v3.quoterV2, abi: V3_QUOTER_PATH_ABI, functionName: "quoteExactInput",
      args: [path, amountInRaw],
    });
    return result[0];
  }
  try {
    const { result } = await httpClient(chainKey).simulateContract({
      address: getChain(chainKey).v4.quoter,
      abi: V4_QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ ...venue.poolKey }, getAddress(currencyIn).toLowerCase() === getAddress(venue.poolKey.currency0).toLowerCase(), amountInRaw, "0x"],
    });
    return result[0];
  } catch (e) {
    // Hooked pools reject the V4 quoter entirely (verified 2026-09-10: the
    // long.xyz hook AND SIRIUS's 0xE5e7… hook both revert on quoteExactInputSingle)
    // but accept real swaps — fall back to the slot0 raw spot price:
    // raw1/raw0 = s², decimal-independent.
    if (venue.poolKey?.hooks && venue.poolKey.hooks !== "0x0000000000000000000000000000000000000000") {
      const poolId = venue.poolId ?? derivePoolId(venue.poolKey);
      const c = httpClient(chainKey);
      const [sqrtPriceX96] = await c.readContract({ address: getChain(chainKey).v4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] });
      if (sqrtPriceX96 === 0n) return 0n;
      const s = Number(sqrtPriceX96) / 2 ** 96;
      const raw1PerRaw0 = s * s;
      const inIs0 = getAddress(currencyIn).toLowerCase() === getAddress(venue.poolKey.currency0).toLowerCase();
      // s² = raw1/raw0 (output-raw per input-raw when input is currency0).
      // The old code had this inverted (in-is-0 divided instead of multiplied),
      // inflating sell quotes by ~10^30 on SIRIUS.
      const out = inIs0 ? Number(amountInRaw) * raw1PerRaw0 : Number(amountInRaw) / raw1PerRaw0;
      if (!(out > 0) || !Number.isFinite(out)) return 0n;
      return BigInt(Math.floor(out));
    }
    throw e;
  }
}

/**
 * Expected price impact (%) of a buy/sell of `usdSize` at `priceUsd`.
 * impact = avgExecPrice/spotPrice - 1 for buys; spotPrice/avgExecPrice - 1 for
 * sells (both positive numbers = adverse). Returns 0 when not computable.
 */
export async function quoteImpactPct({ venue, cls, tokenMeta, chainKey, side, usdSize, priceUsd, quoteUsd }) {
  if (!(usdSize > 0) || !(priceUsd > 0)) return 0;
  // Without a USD price for the quote asset we cannot size the leg honestly —
  // treat as infinite impact so the engine blocks rather than trading blind.
  if (!(quoteUsd > 0)) return Infinity;
  const tokenDecimals = tokenMeta.decimals ?? 18;
  try {
    if (side === "buy") {
      // How much quote currency does usdSize buy? ETH pools: wei. ERC-20 pools: quote raw.
      const amountInRaw = cls.kind === "eth"
        ? BigInt(Math.round((usdSize / (quoteUsd || priceUsd)) * 1e18))
        : BigInt(Math.round((usdSize / (quoteUsd || 1)) * 10 ** (cls.quoteDecimals ?? 18)));
      const tokensOutRaw = await quoteExactInOnVenue(venue, cls.quote, amountInRaw, chainKey);
      if (tokensOutRaw <= 0n) return Infinity; // no liquidity — block the trade
      const tokensOut = Number(tokensOutRaw) / 10 ** tokenDecimals;
      const avgPrice = usdSize / tokensOut;
      return (avgPrice / priceUsd - 1) * 100;
    } else {
      // Selling tokens worth usdSize: quote the receive side.
      const tokenAmount = usdSize / priceUsd;
      const amountRaw = BigInt(Math.round(tokenAmount * 10 ** tokenDecimals));
      const quoteOutRaw = await quoteExactInOnVenue(venue, cls.tokenAddress, amountRaw, chainKey);
      if (quoteOutRaw <= 0n) return Infinity;
      // Quote decimals: ETH pools are 18; ERC-20 quotes (USDG/USDC) are 6 —
      // divide by the REAL quote decimals or the USD conversion is off by 10^12.
      const quoteDec = cls.kind === "eth" ? 18 : await getQuoteTokenDecimals(cls.quote, chainKey);
      const quoteOut = Number(quoteOutRaw) / 10 ** quoteDec;
      const quoteOutUsd = quoteOut * (quoteUsd || 1);
      return (1 - quoteOutUsd / usdSize) * 100;
    }
  } catch {
    return 0; // quote failure shouldn't fabricate impact; other gates still apply
  }
}

// ── execution ────────────────────────────────────────────────────────────────

/** Path payload shape from dip-swap.mjs (IV4Router ExactInputParams has an
 *  unpublished trailing field — see the long comment there). Copied here so
 *  mm-swap stays self-contained for the sell + ERC-20-quote legs. */
function buildV4PathPayload({ currencyIn, token, fee, tickSpacing, hooks, amountIn, amountOutMinimum }) {
  const wn = (n) => BigInt(n).toString(16).padStart(64, "0");
  const addr = (a) => a.slice(2).toLowerCase().padStart(64, "0");
  const HEAD_WORDS = 5;
  const PATH_WORDS = 8;
  const pathOffset = HEAD_WORDS * 32;
  const emptyFieldOffset = pathOffset + PATH_WORDS * 32;
  const tuple = [
    addr(currencyIn), wn(pathOffset), wn(emptyFieldOffset), wn(amountIn), wn(amountOutMinimum),
    wn(1), wn(0x20), addr(token), wn(fee), wn(tickSpacing), addr(hooks), wn(0xa0), wn(0), wn(0),
  ];
  return "0x" + wn(0x20) + tuple.join("");
}

async function ensurePermit2Allowance({ signer, chainKey, token, amountRaw, dryRun }) {
  const dep = getChain(chainKey);
  const c = httpClient(chainKey);
  const [erc20Allowance, p2] = await Promise.all([
    c.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [signer.address, PERMIT2_ADDRESS] }).catch(() => 0n),
    c.readContract({ address: PERMIT2_ADDRESS, abi: PERMIT2_ABI, functionName: "allowance", args: [signer.address, token, dep.v4.universalRouter] }).catch(() => ({ amount: 0n, expiration: 0n })),
  ]);
  if (dryRun) return;
  if (erc20Allowance < amountRaw) {
    const tx = await signer.callContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [PERMIT2_ADDRESS, MAX_UINT160] });
    const receipt = await c.waitForTransactionReceipt({ hash: tx });
    recordGasForTx(tx, chainKey).catch(() => {});
    if (receipt.status !== "success") throw new Error(`approval tx reverted on-chain (${tx})`);
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (p2.amount < amountRaw || BigInt(p2.expiration ?? 0) <= nowSec) {
    const tx = await signer.callContract({ address: PERMIT2_ADDRESS, abi: PERMIT2_ABI, functionName: "approve", args: [token, dep.v4.universalRouter, MAX_UINT160, MAX_UINT48] });
    const receipt = await c.waitForTransactionReceipt({ hash: tx });
    recordGasForTx(tx, chainKey).catch(() => {});
    if (receipt.status !== "success") throw new Error(`Permit2 approval tx reverted on-chain (${tx})`);
  }
}

/**
 * BUY `usdSize` of the token.
 *  - ETH-quoted venue  → buyDip() (native ETH, verified path incl. hooks).
 *  - dollar-quoted     → buyDipWithDollar() (Permit2 + USDG, verified path).
 *  - other ERC-20 quote→ generic UR swap paying with the quote token.
 */
export async function executeMmBuy({ signer, chainKey, venue, cls, tokenMeta, usdSize, priceUsd, quoteUsd, slippagePct = 3, dryRun = false }) {
  const dep = getChain(chainKey);
  const tokenAddress = cls.tokenIs0 ? venue.poolKey.currency0 : venue.poolKey.currency1;
  const token = getAddress(tokenAddress);

  if (cls.kind === "eth") {
    const ethUsd = quoteUsd;
    if (!(ethUsd > 0)) throw new Error("ETH/USD unavailable for sizing");
    const ethAmountWei = BigInt(Math.round((usdSize / ethUsd) * 1e18));
    if (dryRun) {
      const quotedOut = await quoteExactInOnVenue(venue, ETH_ADDRESS, ethAmountWei, chainKey);
      return { dryRun: true, quotedOut };
    }
    const result = await buyDip(signer, token, ethAmountWei, { slippagePct, pool: venue, chainKey });
    return { ...result, usdSize };
  }

  // ERC-20-quoted buy (covers USDG via buyDipWithDollar when applicable).
  // The old line called quoteIsDollarQuote(cls, dep) — a function that never
  // existed (refactor leftover), so every dollar-quoted MM buy crashed with a
  // ReferenceError. Use the local computed above.
  const quoteIsDollar = getAddress(cls.quote).toLowerCase() === getAddress(dep.dollar).toLowerCase();
  if (quoteIsDollar) {
    return buyDipWithDollar(signer, token, usdSize, { slippagePct, pool: venue, chainKey });
  }

  // Generic quote-token buy, mirroring buyDipWithDollar's UR actions.
  const quoteMeta = await getTokenMeta(cls.quote, chainKey);
  const quoteDecimals = quoteMeta.decimals ?? 18;
  const quotePrice = quoteUsd; // USD per quote token
  if (!(quotePrice > 0)) throw new Error("quote token USD price unavailable — cannot size a quote-denominated buy");
  const amountInRaw = BigInt(Math.round((usdSize / quotePrice) * 10 ** quoteDecimals));
  const quotedOut = await quoteExactInOnVenue(venue, cls.quote, amountInRaw, chainKey);
  if (quotedOut <= 0n) throw new Error("quote returned 0 tokens out — refusing to send a doomed tx");
  const bps = BigInt(Math.round(slippagePct * 100));
  const amountOutMinimum = quotedOut - (quotedOut * bps) / 10000n;
  await ensurePermit2Allowance({ signer, chainKey, token: cls.quote, amountRaw: amountInRaw, dryRun });
  if (dryRun) return { dryRun: true, quotedOut, amountOutMinimum };

  const swapParams = buildV4PathPayload({
    currencyIn: cls.quote, token, fee: venue.poolKey.fee, tickSpacing: venue.poolKey.tickSpacing,
    hooks: venue.poolKey.hooks, amountIn: amountInRaw, amountOutMinimum,
  });
  const actions = "0x070b0e";
  const settleParams = encodeAbiParameters(parseAbiParameters("address currency, uint256 amount, bool payerIsUser"), [cls.quote, 0n, true]);
  const takeParams = encodeAbiParameters(parseAbiParameters("address currency, address recipient, uint256 amount"), [token, getAddress(signer.address), 0n]);
  const v4Payload = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [swapParams, settleParams, takeParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const txHash = await signer.callContract({
    address: dep.v4.universalRouter, abi: UR_EXECUTE_ABI, functionName: "execute",
    args: ["0x10", [v4Payload], deadline], value: 0n,
  });
  const receipt = await httpClient(chainKey).waitForTransactionReceipt({ hash: txHash });
  recordGasForTx(txHash, chainKey).catch(() => {});
  if (receipt.status !== "success") throw new Error(`buy tx reverted on-chain (${txHash})`);
  return { txHash, quotedOut, amountOutMinimum, usdSize };
}

function quoteIsDollar(cls, dep) {
  return getAddress(cls.quote).toLowerCase() === getAddress(dep.dollar).toLowerCase();
}

/**
 * SELL `amountTokensHuman` tokens → the venue's quote asset (ETH or ERC-20).
 * Mirrors the buy legs: SWAP_EXACT_IN(token→quote), SETTLE(payerIsUser),
 * TAKE(quote→wallet), through the same hooked-pool-safe path encoding.
 */
export async function executeMmSell({ signer, chainKey, venue, cls, tokenMeta, amountTokensHuman, quoteUsd, slippagePct = 3, dryRun = false }) {
  const dep = getChain(chainKey);
  const token = cls.tokenIs0 ? venue.poolKey.currency0 : venue.poolKey.currency1;
  const quoteCurrency = cls.tokenIs0 ? venue.poolKey.currency1 : venue.poolKey.currency0;
  const tokenDecimals = tokenMeta.decimals ?? 18;
  const amountRaw = BigInt(Math.round(Number(amountTokensHuman) * 10 ** tokenDecimals));
  if (amountRaw <= 0n) throw new Error("sell amount must be positive");

  const quotedOut = await quoteExactInOnVenue(venue, token, amountRaw, chainKey);
  if (quotedOut <= 0n) throw new Error("sell quote returned 0 — no liquidity in that direction");
  const bps = BigInt(Math.round(slippagePct * 100));
  const amountOutMinimum = quotedOut - (quotedOut * bps) / 10000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  await ensurePermit2Allowance({ signer, chainKey, token, amountRaw, dryRun });
  if (dryRun) return { dryRun: true, quotedOut, amountOutMinimum };

  const swapParams = buildV4PathPayload({
    currencyIn: token, token: quoteCurrency, fee: venue.poolKey.fee,
    tickSpacing: venue.poolKey.tickSpacing, hooks: venue.poolKey.hooks,
    amountIn: amountRaw, amountOutMinimum,
  });
  const actions = "0x070b0e";
  const settleParams = encodeAbiParameters(parseAbiParameters("address currency, uint256 amount, bool payerIsUser"), [token, 0n, true]);
  const takeParams = encodeAbiParameters(parseAbiParameters("address currency, address recipient, uint256 amount"), [quoteCurrency, getAddress(signer.address), 0n]);
  const v4Payload = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [swapParams, settleParams, takeParams]]);

  const txHash = await signer.callContract({
    address: dep.v4.universalRouter, abi: UR_EXECUTE_ABI, functionName: "execute",
    args: ["0x10", [v4Payload], deadline], value: 0n,
  });
  const receipt = await httpClient(chainKey).waitForTransactionReceipt({ hash: txHash });
  recordGasForTx(txHash, chainKey).catch(() => {});
  if (receipt.status !== "success") throw new Error(`sell tx reverted on-chain (${txHash})`);
  return { txHash, quotedOut, amountOutMinimum };
}
