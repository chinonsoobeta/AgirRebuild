import type { EngineInput, StressPreset } from "@agir/contracts";

/** A stress is a full re-run of the model on a shocked input. Nothing is synthesized. */
export function applyStress(input: EngineInput, s: StressPreset): EngineInput {
  const cost = 1 + (s.costPct ?? 0) / 100;
  const rent = 1 + (s.rentPct ?? 0) / 100;
  const rate = (s.rateBps ?? 0) / 100;
  const occ = s.occupancyPts ?? 0;
  const exp = s.expensePts ?? 0;
  const clampPct = (x: number) => Math.min(100, Math.max(0, x));
  const out: EngineInput = {
    ...input,
    budget: {
      land: input.budget.land * cost,
      hard: input.budget.hard * cost,
      soft: input.budget.soft * cost,
      contingency: input.budget.contingency * cost,
      // A credit shrinks with the costs it offsets but never grows: an overrun never enlarges it.
      other: input.budget.other < 0 ? input.budget.other * Math.min(cost, 1) : input.budget.other * cost,
    },
    revenue: input.revenue.map((c) => ({
      ...c,
      ...(c.rentMonthly !== undefined ? { rentMonthly: c.rentMonthly * rent } : {}),
      ...(c.rentPsfAnnual !== undefined ? { rentPsfAnnual: c.rentPsfAnnual * rent } : {}),
      ...(c.occupancyPct !== undefined ? { occupancyPct: clampPct(c.occupancyPct + occ) } : {}),
    })),
    stabilizedOccupancyPct: clampPct(input.stabilizedOccupancyPct + occ),
    exitCapPct: input.exitCapPct + (s.exitCapBps ?? 0) / 100,
    senior: { ...input.senior, ratePct: input.senior.ratePct + (input.senior.amount > 0 ? rate : 0) },
    ...(input.mezzanine ? { mezzanine: { ...input.mezzanine, ratePct: input.mezzanine.ratePct + rate } } : {}),
    ...(input.refinance ? { refinance: { ...input.refinance, ratePct: input.refinance.ratePct + rate } } : {}),
  };
  // The expense shock moves whichever field controls the expense line.
  if (exp !== 0) {
    if (input.expenseRatioPct !== undefined) out.expenseRatioPct = clampPct(input.expenseRatioPct + exp);
    else out.variableExpensePct = clampPct((input.variableExpensePct ?? 0) + exp);
  }
  return out;
}
