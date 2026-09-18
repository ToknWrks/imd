/**
 * Zooch converts market evidence into a validated hybrid accumulation proposal.
 * The AI proposes the actual settings (within hard guardrails) from simulated
 * price-impact curves, venue liquidity/flow, and chart technicals; deterministic
 * heuristics are only the fallback when the AI is unavailable. The AI's numbers
 * are always clamped to hard limits and re-validated before anything is applied.
 */
import { collectZoochEvidence } from "./zooch-data.mjs";
import { simulateSellImpact, analyzeTechnicals } from "./zooch-analysis.mjs";
import { completeZoochReview, failZoochReview, getZoochReview, setZoochReviewRunning } from "./db.mjs";

const PROFILES = {
  conservative: { cadenceDays: 7, dipReserve: 0.5, dipMultiplier: 1, cooldownMinutes: 240, slippagePct: 1.5 },
  balanced: { cadenceDays: 3, dipReserve: 0.35, dipMultiplier: 1.25, cooldownMinutes: 90, slippagePct: 3 },
  aggressive: { cadenceDays: 1, dipReserve: 0.2, dipMultiplier: 1.75, cooldownMinutes: 30, slippagePct: 5 },
};

const NARRATIVE_KEYS = ["summary", "marketAssessment", "chartAssessment", "impactAssessment", "strategyRationale", "risks"];

function roundUsd(value) {
  return Math.round(value * 100) / 100;
}

function sqlDate(date) {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export function validateZoochRequest(input) {
  const profile = input.profile;
  const totalBudgetUsd = Number(input.totalBudgetUsd);
  const maxBuyUsd = Number(input.maxBuyUsd);
  const periodDays = Number(input.periodDays);
  if (!PROFILES[profile]) throw new Error("profile must be conservative, balanced, or aggressive");
  if (!(totalBudgetUsd > 0)) throw new Error("total budget must be a positive number");
  if (!(maxBuyUsd > 0)) throw new Error("per-buy maximum must be a positive number");
  if (!(periodDays >= 1 && periodDays <= 365)) throw new Error("accumulation period must be between 1 and 365 days");
  return { profile, totalBudgetUsd: roundUsd(totalBudgetUsd), maxBuyUsd: roundUsd(maxBuyUsd), periodDays: Math.floor(periodDays) };
}

/** Heuristic fallback when the AI planner is unavailable. */
function heuristicProposal(request, evidence) {
  const settings = PROFILES[request.profile];
  const cadenceMinutes = settings.cadenceDays * 24 * 60;
  const trancheCount = Math.max(1, Math.ceil(request.periodDays / settings.cadenceDays));
  const baseAllocation = request.totalBudgetUsd * (1 - settings.dipReserve);
  const baseBuyUsd = roundUsd(Math.min(request.maxBuyUsd, baseAllocation / trancheCount));
  const scheduledAllocationUsd = roundUsd(baseBuyUsd * trancheCount);
  const dipReserveUsd = roundUsd(Math.max(0, request.totalBudgetUsd - scheduledAllocationUsd));
  // Prefer the observed sell-size distribution (Graph subgraphs, per-trade USD)
  // over the volume÷txns estimate — it reflects what sells actually look like
  // and captures venue skew (e.g. a huge V4 pool beside a tiny V3 pool).
  const trades = evidence.trades;
  const dipThresholdUsd = roundUsd(
    trades?.status === "available" && trades.p95SellUsd != null
      ? Math.max(100, trades.p95SellUsd)
      : (() => {
          const h24 = evidence.market?.txns?.h24;
          const volume24h = evidence.market?.volume?.h24 ?? 0;
          const trades24h = h24 ? (h24.buys ?? 0) + (h24.sells ?? 0) : 0;
          const avgTradeUsd = trades24h > 0 ? volume24h / trades24h : null;
          const fallbackThreshold = Math.max(request.maxBuyUsd * 5, 1_000);
          return Math.max(100, avgTradeUsd ? avgTradeUsd * 20 : fallbackThreshold);
        })()
  );
  const dipBuyUsd = roundUsd(Math.min(
    request.maxBuyUsd, dipReserveUsd,
    Math.max(baseBuyUsd, dipReserveUsd / Math.max(1, Math.ceil(trancheCount / 2))) * settings.dipMultiplier,
  ));
  return { maxBuyUsd: request.maxBuyUsd, cadenceMinutes, trancheCount, baseBuyUsd, scheduledAllocationUsd, dipReserveUsd, dipThresholdUsd, dipBuyUsd, slippagePct: settings.slippagePct, cooldownMinutes: settings.cooldownMinutes };
}

/** Clamp the AI's proposed numbers into the hard risk limits. */
function normalizeAiProposal(ai, request) {
  const settings = PROFILES[request.profile];
  const clamp = (value, lo, hi, dflt) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  const totalBudgetUsd = request.totalBudgetUsd;
  // Per-buy ceiling: the user's max, but never more than 1/3 of the budget in one buy.
  const maxBuyCeiling = Math.min(request.maxBuyUsd, totalBudgetUsd / 3);
  const maxBuyUsd = roundUsd(clamp(ai.maxBuyUsd, Math.min(1, totalBudgetUsd / 100), maxBuyCeiling, maxBuyCeiling));
  const cadenceMinutes = clamp(ai.cadenceHours != null ? Number(ai.cadenceHours) * 60 : null, 30, request.periodDays * 24 * 60, settings.cadenceDays * 24 * 60);
  const trancheCount = Math.max(1, Math.floor((request.periodDays * 24 * 60) / cadenceMinutes));
  const baseBuyUsd = roundUsd(clamp(ai.baseBuyUsd, 0.01, maxBuyUsd, roundUsd(Math.min(maxBuyUsd, (totalBudgetUsd * 0.65) / trancheCount))));
  // Cap scheduled allocation at 90% of budget so a minimum dip reserve always
  // exists — the validator requires dipBuyUsd > 0 AND dipBuyUsd <= dipReserveUsd.
  const scheduledAllocationUsd = roundUsd(Math.min(totalBudgetUsd * 0.9, baseBuyUsd * trancheCount));
  const dipReserveUsd = roundUsd(Math.max(0, totalBudgetUsd - scheduledAllocationUsd));
  const dipBuyUsd = roundUsd(clamp(ai.dipBuyUsd, 0.01, Math.min(maxBuyUsd, Math.max(0.01, dipReserveUsd)), Math.min(maxBuyUsd, Math.max(0.01, dipReserveUsd))));
  const dipThresholdUsd = roundUsd(clamp(ai.dipThresholdUsd, 100, 1_000_000, 5_000));
  const slippagePct = clamp(ai.slippagePct, 0.1, 15, settings.slippagePct);
  const cooldownMinutes = clamp(ai.cooldownMinutes, 1, 10_080, settings.cooldownMinutes);
  return { maxBuyUsd, cadenceMinutes, trancheCount, baseBuyUsd, scheduledAllocationUsd, dipReserveUsd, dipThresholdUsd, dipBuyUsd, slippagePct, cooldownMinutes };
}

/**
 * Build a plan. `aiPlan` (from generateAiPlan) provides the settings; when
 * absent, deterministic heuristics are used. Impact + technicals are embedded
 * in the proposal as marketAnalysis either way.
 */
export async function buildZoochProposal(request, evidence, { aiPlan = null } = {}) {
  const start = new Date();
  const end = new Date(start.getTime() + request.periodDays * 24 * 60 * 60 * 1000);

  const chainKey = evidence.chain || "ethereum";
  const impact = await simulateSellImpact(evidence.contractAddress, evidence.decimals ?? 18, undefined, chainKey).catch((e) => ({ error: e.message }));
  const { technicals: tech } = await analyzeTechnicals(evidence.contractAddress, 30, chainKey).catch(() => ({ technicals: {} }));

  const core = aiPlan ? normalizeAiProposal(aiPlan, request) : heuristicProposal(request, evidence);
  const plannedBy = aiPlan ? "ai" : "heuristic";

  const warnings = [];
  if (impact.error) warnings.push(`Price-impact simulation unavailable: ${impact.error}`);
  if (tech.error) warnings.push(`Chart technicals unavailable: ${tech.error}`);
  if (impact.points?.some((p) => p.impactPct == null)) warnings.push("A simulated sell exceeded available pool depth; the largest sizes may be unfillable.");
  const h24 = evidence.market?.txns?.h24;
  if (h24 && (h24.buys ?? 0) + (h24.sells ?? 0) < 20) warnings.push("Low 24h trading activity makes flow-based thresholds less reliable.");
  if (evidence.trades?.status === "available") {
    const t = evidence.trades;
    if (t.sellCount < 10) warnings.push(`Only ${t.sellCount} token sells observed in the last ${t.windowHours}h — sell-size percentiles are thin evidence.`);
    if ((t.venues ?? []).length > 1) {
      const skew = Math.max(...t.venues.map((v) => v.p95SellUsd ?? 0)) / Math.max(1, Math.min(...t.venues.filter((v) => (v.p95SellUsd ?? 0) > 0).map((v) => v.p95SellUsd ?? Infinity)));
      if (Number.isFinite(skew) && skew > 10) warnings.push("Sell sizes differ by more than 10x between venues; the combined percentiles lean toward the deeper pool.");
    }
  } else if (evidence.trades) {
    warnings.push(`Per-trade sell-size history unavailable: ${evidence.trades.error ?? "unknown reason"}`);
  }
  if (evidence.holders?.status !== "available") warnings.push("Holder concentration data unavailable (needs a paid holder indexer; market data is unaffected).");
  if (evidence.holders?.topHolderSupplyPct != null && evidence.holders.topHolderSupplyPct > 50) warnings.push("Top indexed holders control more than half of the token supply sample.");

  return {
    version: 2,
    plannedBy,
    profile: request.profile,
    totalBudgetUsd: request.totalBudgetUsd,
    maxBuyUsd: core.maxBuyUsd,
    periodDays: request.periodDays,
    startAt: sqlDate(start),
    endAt: sqlDate(end),
    cadenceMinutes: core.cadenceMinutes,
    cadenceLabel: `${Math.round((core.cadenceMinutes / 1440) * 10) / 10} day${core.cadenceMinutes === 1440 ? "" : "s"}`,
    baseBuyUsd: core.baseBuyUsd,
    scheduledTrancheCount: core.trancheCount,
    scheduledAllocationUsd: core.scheduledAllocationUsd,
    dipReserveUsd: core.dipReserveUsd,
    dipBuyUsd: core.dipBuyUsd,
    dipThresholdUsd: core.dipThresholdUsd,
    cooldownMinutes: core.cooldownMinutes,
    slippagePct: core.slippagePct,
    marketAnalysis: {
      priceImpact: impact.error ? { error: impact.error } : { venue: impact.venue, spotPriceUsd: impact.spotPriceUsd, points: impact.points },
      technicals: tech,
    },
    warnings,
    methodology: plannedBy === "ai"
      ? "Settings proposed by AI from simulated price-impact curves, venue liquidity/flow, and daily-chart technicals; clamped to hard risk limits and re-validated. Not investment advice."
      : "Deterministic heuristics (AI planner unavailable). Not investment advice.",
  };
}

export function validateZoochProposal(proposal) {
  if (!proposal || !PROFILES[proposal.profile]) throw new Error("invalid Zooch proposal profile");
  const numeric = [
    "totalBudgetUsd", "maxBuyUsd", "baseBuyUsd", "dipBuyUsd", "dipThresholdUsd",
    "slippagePct", "cooldownMinutes", "cadenceMinutes", "scheduledAllocationUsd", "dipReserveUsd",
  ];
  if (numeric.some((key) => !Number.isFinite(Number(proposal[key])) || Number(proposal[key]) < 0)) {
    throw new Error("Zooch proposal contains invalid numeric settings");
  }
  if (!(proposal.totalBudgetUsd > 0 && proposal.maxBuyUsd > 0 && proposal.baseBuyUsd > 0 && proposal.dipBuyUsd > 0)) {
    throw new Error("Zooch proposal requires positive budget and buy amounts");
  }
  if (proposal.baseBuyUsd > proposal.maxBuyUsd || proposal.dipBuyUsd > proposal.maxBuyUsd || proposal.dipBuyUsd > proposal.dipReserveUsd) {
    throw new Error("Zooch proposal exceeds its per-buy or dip-reserve limit");
  }
  if (proposal.scheduledAllocationUsd + proposal.dipReserveUsd > proposal.totalBudgetUsd + 0.001) {
    throw new Error("Zooch proposal exceeds its total budget");
  }
  if (!(Date.parse(`${proposal.startAt}Z`) < Date.parse(`${proposal.endAt}Z`))) {
    throw new Error("Zooch proposal has an invalid accumulation period");
  }
  return proposal;
}

export const AI_SYSTEM_PROMPT = `You are Zooch, an on-chain token accumulation planner. You receive:
- request: the user's budget, max per-buy, period, and risk profile
- evidence.market: per-venue liquidity, volume, buy/sell counts, price momentum (Dexscreener)
- evidence.trades: observed per-trade sell-size distribution over the last 72h from The Graph (p50/p90/p95/max sell USD per venue, plus combined percentiles and the largest recent sells). When available, prefer it over estimates: set dipThresholdUsd near the observed p90-p95 sell size (clamped 100-1000000) so the trigger fires on sells that actually happen, and check per-venue p95s for skew — if one venue dominates, weight its distribution.
- impact: simulated price impact of sells of increasing size through the token's real deepest pool (points: sellUsd -> impactPct)
- technicals: daily-chart SMA7/20/50, RSI(14), realized volatility, drawdown, trend

Propose an accumulation plan. Respond with JSON with EXACTLY these keys:
{"plan": {"baseBuyUsd": number, "dipBuyUsd": number, "dipThresholdUsd": number, "cadenceHours": number, "maxBuyUsd": number, "slippagePct": number, "cooldownMinutes": number}, "narrative": {"summary": string, "marketAssessment": string, "chartAssessment": string, "impactAssessment": string, "strategyRationale": string, "risks": string}}

Reasoning to apply:
- dipThresholdUsd is a DOLLAR SELL SIZE (the USD value of tokens being sold by someone else), not a percentage. Use the impact curve: find the sellUsd whose simulated impactPct lands in the 2-5% band, and set dipThresholdUsd to that sellUsd value (between 100 and 1000000). Example: if the curve shows a $10,000 sell moves price 2.6%, then dipThresholdUsd ≈ 10000. Cite the curve in impactAssessment.
- Scale baseBuyUsd so the scheduled buys fit the budget over the period at your cadence; keep dipBuyUsd <= maxBuyUsd and <= the dip reserve.
- request.maxBuyUsd is a hard ceiling you must never exceed.
- Use the chart to tilt: RSI > 70 or downtrend -> wider cadence, smaller base buys, larger dip reserve; RSI < 35 -> tighter cadence acceptable. High realized volatility -> smaller per-buy sizes and higher slippage tolerance.
- Thin liquidity relative to your per-buy size -> raise slippage and lower per-buy size.
- In the narrative, explain your reasoning from the supplied data. No price predictions, no investment advice. All six narrative keys are required strings.`;

/**
 * One AI call that both proposes the plan's numeric settings and explains the
 * reasoning. The returned plan is clamped by normalizeAiProposal before use.
 */
async function generateAiPlan({ request, evidence, impact, technicals }) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OpenAI API key is not configured.");
  const model = process.env.OPENAI_MODEL?.trim() || "openai-gpt-4o-mini-2024-07-18";
  const response = await fetch("https://api.venice.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      temperature: 0.3,
      messages: [
        { role: "system", content: AI_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ request, market: evidence.market, trades: evidence.trades ?? null, holders: { status: evidence.holders?.status ?? "unavailable" }, impact, technicals }) },
      ],
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Venice request failed: HTTP ${response.status}`);
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI returned no plan content");
  let parsed;
  try { parsed = JSON.parse(content); } catch { throw new Error("AI returned an invalid plan format"); }
  if (!parsed?.plan || !parsed?.narrative) throw new Error("AI response missing plan or narrative");
  for (const key of NARRATIVE_KEYS) {
    if (!(key in parsed.narrative) || parsed.narrative[key] == null) throw new Error(`AI narrative omitted ${key}`);
    if (typeof parsed.narrative[key] !== "string") parsed.narrative[key] = JSON.stringify(parsed.narrative[key]);
  }
  return { plan: parsed.plan, narrative: parsed.narrative, model };
}

export async function runZoochReview(reviewId) {
  const review = getZoochReview(reviewId);
  if (!review) throw new Error("Zooch review not found");
  setZoochReviewRunning(reviewId);
  try {
    const request = validateZoochRequest(review.request);
    const chainKey = review.chain || "ethereum";
    const evidence = await collectZoochEvidence({ contractAddress: review.contract_address, decimals: review.request.decimals, chainKey });
    evidence.decimals = review.request.decimals ?? 18;

    // Gather the deep evidence once and hand it to both the AI planner and
    // (via buildZoochProposal) the final proposal's marketAnalysis block.
    const impact = await simulateSellImpact(evidence.contractAddress, evidence.decimals, undefined, chainKey).catch((e) => ({ error: e.message }));
    const { technicals } = await analyzeTechnicals(evidence.contractAddress, 30, chainKey).catch(() => ({ technicals: {} }));

    let ai = null;
    let narrative;
    try {
      ai = await generateAiPlan({ request, evidence, impact, technicals });
      narrative = { status: "available", model: ai.model, content: ai.narrative };
    } catch (error) {
      narrative = { status: "failed", error: error.message, content: null };
    }

    const proposal = await buildZoochProposal(request, evidence, { aiPlan: ai?.plan ?? null });
    completeZoochReview(reviewId, { evidence, proposal, narrative });
  } catch (error) {
    failZoochReview(reviewId, error.message);
  }
}
