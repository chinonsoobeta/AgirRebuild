// Small numeric helpers. Pure; no clock, no randomness, no I/O.

/** Round to the cent, half away from zero. */
export function cents(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x) * 100) / 100;
}

/**
 * Split `total` across `weights` so the parts sum to `total` exactly, in
 * cents, by largest remainder. Used wherever a budget line is spread over
 * months, so no dollar is created or lost by rounding.
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const totalCents = Math.round(total * 100);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error("allocate: weights must sum to a positive number");
  const raw = weights.map((w) => (totalCents * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder -= 1;
  }
  return floors.map((c) => c / 100);
}

/** Level monthly payment that retires `principal` over `months` at `annualRatePct`. */
export function levelPayment(principal: number, annualRatePct: number, months: number): number {
  if (principal <= 0) return 0;
  if (months <= 0) throw new Error("levelPayment: months must be positive");
  const r = annualRatePct / 100 / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}

/** Smoothstep: the cumulative share of an S-curve draw at fraction x of the build. */
export function smoothstep(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/** Monthly draw shares over a build of `months`: straight-line or S-curve. Sums to 1. */
export function drawShares(months: number, sCurve: boolean): number[] {
  if (months <= 0) return [1];
  const shares: number[] = [];
  for (let m = 0; m < months; m++) {
    shares.push(sCurve ? smoothstep((m + 1) / months) - smoothstep(m / months) : 1 / months);
  }
  return shares;
}

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/** A ratio that is not meaningful when the denominator is zero or not finite. */
export function ratio(n: number, d: number): number | null {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}
