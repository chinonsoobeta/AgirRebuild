// IRR over dated cash flows. Decision 3: every root is found; one root is an
// answer, zero or several are "not meaningful" and are reported as such.

export type DatedFlow = { t: number; amount: number };

function npv(rate: number, flows: readonly DatedFlow[]): number {
  let v = 0;
  for (const f of flows) v += f.amount / Math.pow(1 + rate, f.t);
  return v;
}

function bisect(lo: number, hi: number, flows: readonly DatedFlow[]): number {
  let flo = npv(lo, flows);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fmid = npv(mid, flows);
    if (Math.abs(fmid) < 1e-9 || hi - lo < 1e-12) return mid;
    if (Math.sign(fmid) === Math.sign(flo)) {
      lo = mid;
      flo = fmid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Every annual rate in (-99%, 1000%) at which the NPV of the flows is zero,
 * found by scanning for sign changes and refining each by bisection. Roots
 * closer than 1e-6 (relative) are the same root.
 */
export function irrRoots(flows: readonly DatedFlow[]): number[] {
  const nonZero = flows.filter((f) => f.amount !== 0);
  const hasNeg = nonZero.some((f) => f.amount < 0);
  const hasPos = nonZero.some((f) => f.amount > 0);
  if (!hasNeg || !hasPos) return [];
  // Denser grid near the rates deals actually earn.
  const grid: number[] = [];
  for (let r = -0.99; r < -0.5; r += 0.01) grid.push(r);
  for (let r = -0.5; r < 1; r += 0.0005) grid.push(r);
  for (let r = 1; r <= 10; r += 0.01) grid.push(r);
  const roots: number[] = [];
  let prevR = grid[0]!;
  let prevV = npv(prevR, nonZero);
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]!;
    const v = npv(r, nonZero);
    if (v === 0) {
      roots.push(r);
    } else if (Number.isFinite(v) && Number.isFinite(prevV) && Math.sign(v) !== Math.sign(prevV) && prevV !== 0) {
      roots.push(bisect(prevR, r, nonZero));
    }
    prevR = r;
    prevV = v;
  }
  const unique: number[] = [];
  for (const r of roots) {
    if (!unique.some((u) => Math.abs(u - r) <= 1e-6 * Math.max(1, Math.abs(u)))) unique.push(r);
  }
  return unique;
}
