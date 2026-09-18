/**
 * mm-routes.mjs — /mm page + /api/mm/* handlers. Same contract as
 * sniper-routes.mjs: return true when the request was handled.
 */
import {
  listMmStrategies, getMmStrategy, createMmStrategy, updateMmStrategy,
  deleteMmStrategy, getMmTrades, getMmTodayFlows, countMmTradesToday,
} from "./mm-db.mjs";
import { normalizeMmConfig, decideTrade, summarizeExternalFlow } from "./mm-engine.mjs";
import { resolveMmVenue, getMmSnapshot, quoteImpactPct } from "./mm-swap.mjs";
import { resolveMmSigner } from "./signer.mjs";
import { getErc20Balance } from "./dip-swap.mjs";
import { getChain } from "./chains.mjs";
import { mmPage, getMmWalletCards } from "./mm-page.mjs";

export async function handleMmRequest(url, method, { readBody, json, send, shell, esc, explorerLink, getChain: getChainFn }) {
  if (url === "/mm" && method === "GET") {
    send(await mmPage({ shell, esc, explorerLink, getChain: getChainFn }));
    return true;
  }

  // Live MM wallet balances for the refresh icon (no page reload).
  if (url === "/api/mm/wallets" && method === "POST") {
    try {
      json({ ok: true, cards: await getMmWalletCards() });
    } catch (e) { json({ ok: false, error: e.message }); }
    return true;
  }

  if (url === "/api/mm/strategies" && method === "POST") {
    try {
      const body = JSON.parse(await readBody());
      const chain = body.chain || "robinhood";
      getChain(chain); // throws on unknown chain
      if (!/^0x[0-9a-fA-F]{40}$/.test(body.token_address ?? "")) {
        json({ ok: false, error: "invalid token address" }); return true;
      }
      // Resolve the venue NOW so a typo'd address fails loudly at create time.
      const resolved = await resolveMmVenue(body.token_address, chain, body.venue_override || null);
      const cfg = normalizeMmConfig(body);
      const s = createMmStrategy({
        chain, token_address: body.token_address.toLowerCase(),
        symbol: resolved.meta?.symbol ?? null,
        decimals: resolved.meta?.decimals ?? 18,
        ...cfg,
        venue_override: body.venue_override || null,
      });
      json({ ok: true, strategy: { id: s.id, symbol: s.symbol, venue: resolved.venue.poolId } });
    } catch (e) { json({ ok: false, error: e.message }); }
    return true;
  }

  if (url === "/api/mm/toggle" && method === "POST") {
    try {
      const { id } = JSON.parse(await readBody());
      const s = getMmStrategy(id);
      if (!s) { json({ ok: false, error: "not found" }); return true; }
      // LIVE arming requires explicit consent: dry_run must be explicitly
      // turned off first, and live mode is refused outright for the raw-key
      // signer if no signer is configured (resolveSigner throws in daemon).
      updateMmStrategy(id, { active: s.active ? 0 : 1, error_streak: 0, last_error: null });
      json({ ok: true, active: s.active ? 0 : 1 });
    } catch (e) { json({ ok: false, error: e.message }); }
    return true;
  }

  if (url === "/api/mm/dry" && method === "POST") {
    try {
      const { id, dry } = JSON.parse(await readBody());
      const s = getMmStrategy(id);
      if (!s) { json({ ok: false, error: "not found" }); return true; }
      updateMmStrategy(id, { dry_run: dry ? 1 : 0 });
      json({ ok: true, dry_run: dry ? 1 : 0 });
    } catch (e) { json({ ok: false, error: e.message }); }
    return true;
  }

  if (url === "/api/mm/strategies" && method === "PATCH") {
    try {
      const body = JSON.parse(await readBody());
      const { id, ...patch } = body;
      if (!getMmStrategy(id)) { json({ ok: false, error: "not found" }); return true; }
      const cfg = normalizeMmConfig(patch);
      updateMmStrategy(id, cfg);
      json({ ok: true });
    } catch (e) { json({ ok: false, error: e.message }); }
    return true;
  }

  if (url.startsWith("/api/mm/strategies/") && method === "DELETE") {
    try {
      const id = url.split("/").pop();
      deleteMmStrategy(id);
      json({ ok: true });
    } catch (e) { json({ ok: false, error: e.message }); }
    return true;
  }

  if (url === "/api/mm/status" && method === "POST") {
    try {
      const { id } = JSON.parse(await readBody());
      const s = getMmStrategy(id);
      if (!s) { json({ ok: false, error: "not found" }); return true; }
      const { venue, meta, cls } = await resolveMmVenue(s.token_address, s.chain, s.venue_override || null);
      const snap = await getMmSnapshot(venue, cls, meta, s.chain);
      const cfg = normalizeMmConfig(s);
      const signer = await resolveMmSigner(s.chain).catch(() => null);
      const inventoryTokens = signer ? Number(await getErc20Balance(s.token_address, signer.address, s.chain)) / 10 ** (meta.decimals ?? 18) : 0;
      const decision = decideTrade({
        config: cfg, priceUsd: snap.priceUsd,
        fairValueUsd: s.last_price_usd && s.last_price_usd > 0 ? s.last_price_usd * 0.7 + snap.priceUsd * 0.3 : snap.priceUsd,
        external: { count: 999, netUsd: 0, buysUsd: 0, sellsUsd: 0 },
        lastSide: s.last_side, lastTradeAt: s.last_trade_at,
        tradesToday: countMmTradesToday(s.id), todayFlows: getMmTodayFlows(s.id),
        inventoryTokens, costBasisUsd: s.cost_basis_usd ?? 0,
        liquidityUsd: snap.liquidityUsd,
        impactPct: await quoteImpactPct({ venue, cls: { ...cls, tokenAddress: s.token_address }, tokenMeta: meta, chainKey: s.chain, side: "buy", usdSize: cfg.trade_size_usd, priceUsd: snap.priceUsd, quoteUsd: snap.quoteUsd }),
      });
      json({ ok: true, snapshot: snap, cls, poolId: venue.poolId, symbol: meta?.symbol, decision });
    } catch (e) { json({ ok: false, error: e.message }); }
    return true;
  }

  return false;
}
