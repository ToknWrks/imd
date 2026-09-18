import test from "node:test";
import assert from "node:assert/strict";
import { buildZoochProposal, validateZoochProposal, validateZoochRequest } from "./zooch.mjs";

// Minimal Dexscreener-shape evidence; no contractAddress so the impact/technicals
// collectors fail gracefully and the plan must still be built and valid.
const evidence = {
  market: {
    source: "dexscreener",
    venueCount: 1,
    totalLiquidityUsd: 1_500_000,
    volume: { h24: 500_000 },
    txns: { h24: { buys: 300, sells: 250 } },
    priceUsd: 2.9,
    priceChange: { h1: 0, h6: -2, h24: -5 },
  },
  holders: { status: "unavailable", error: "tier-gated" },
};

test("Zooch validates bounded user inputs", () => {
  assert.deepEqual(validateZoochRequest({
    profile: "balanced", totalBudgetUsd: "1000", maxBuyUsd: "100", periodDays: "30",
  }), { profile: "balanced", totalBudgetUsd: 1000, maxBuyUsd: 100, periodDays: 30 });
  assert.throws(() => validateZoochRequest({
    profile: "balanced", totalBudgetUsd: 0, maxBuyUsd: 100, periodDays: 30,
  }), /total budget/);
});

test("Zooch hybrid plan cannot exceed total budget or per-buy cap", async () => {
  for (const profile of ["conservative", "balanced", "aggressive"]) {
    const proposal = await buildZoochProposal(validateZoochRequest({
      profile, totalBudgetUsd: 1_000, maxBuyUsd: 100, periodDays: 30,
    }), evidence);
    assert.ok(["ai", "heuristic"].includes(proposal.plannedBy));
    assert.ok(proposal.baseBuyUsd <= proposal.maxBuyUsd);
    assert.ok(proposal.dipBuyUsd <= proposal.maxBuyUsd);
    assert.ok(proposal.dipBuyUsd <= proposal.dipReserveUsd);
    assert.ok(proposal.scheduledAllocationUsd + proposal.dipReserveUsd <= proposal.totalBudgetUsd + 0.001);
    assert.ok(proposal.dipThresholdUsd >= 100, "dip threshold has a sane floor");
    assert.ok(Number.isFinite(proposal.cadenceMinutes) && proposal.cadenceMinutes >= 30);
    assert.ok(proposal.marketAnalysis); // impact + technicals block always present
    assert.equal(validateZoochProposal(proposal), proposal);
  }
});

test("AI plan proposals are clamped to hard limits", async () => {
  const request = validateZoochRequest({ profile: "balanced", totalBudgetUsd: 900, maxBuyUsd: 100, periodDays: 30 });
  // A rogue/unhinged AI answer: absurd sizes and a negative threshold.
  const roguePlan = { baseBuyUsd: 10_000, dipBuyUsd: 5_000, dipThresholdUsd: -50, cadenceHours: 0.01, maxBuyUsd: 10_000, slippagePct: 99, cooldownMinutes: 0 };
  const proposal = await buildZoochProposal(request, evidence, { aiPlan: roguePlan });
  assert.equal(proposal.plannedBy, "ai");
  assert.ok(proposal.maxBuyUsd <= request.maxBuyUsd, "per-buy cap enforced");
  assert.ok(proposal.baseBuyUsd <= proposal.maxBuyUsd);
  assert.ok(proposal.dipBuyUsd <= proposal.maxBuyUsd);
  assert.ok(proposal.dipThresholdUsd >= 100, "negative threshold clamped to floor");
  assert.ok(proposal.slippagePct <= 15, "slippage clamped");
  assert.ok(proposal.cadenceMinutes >= 30, "cadence clamped");
  assert.ok(proposal.scheduledAllocationUsd + proposal.dipReserveUsd <= proposal.totalBudgetUsd + 0.001);
  assert.equal(validateZoochProposal(proposal), proposal);
});
