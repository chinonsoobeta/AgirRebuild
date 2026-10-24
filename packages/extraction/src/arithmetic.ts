import type { SourcedCandidate, Proposal } from "./consolidate.ts";

const COSTS = new Set(["land_cost", "hard_cost", "soft_cost", "contingency", "other_cost", "development_charges", "land_transfer_tax", "gst_hst_net"]);
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1000, Math.abs(b) * 0.005);
const scale = (a: number, b: number) => a > 0 && b > 0 && Math.max(a / b, b / a) >= 500 && Math.max(a / b, b / a) <= 2000;

/** Read-time annotations only: never resolve a conflict or supply an input. */
export function checkArithmetic(proposals: Proposal[]): Proposal[] {
  const out = proposals.map(p => { const { check, ...rest } = p; return rest as Proposal; });
  const eligible = out.filter(p => p.status === "needs_review" && p.value !== null && p.values.length === 1);
  const whole = (key: string) => eligible.find(p => p.fieldKey === key && p.itemKey === null);
  const mark = (p: Proposal, outcome: "confirms" | "questions", note: string) => {
    if (p.check?.outcome !== "questions") p.check = { outcome, note };
  };
  const questionScale = (p: Proposal, other: number) => mark(p, "questions", `Please check: this looks about 1,000 times off ${money(other)}`);
  const total = whole("stated_total_cost");
  if (total) {
    const parts = eligible.filter(p => COSTS.has(p.fieldKey) && p.itemKey === null);
    const sum = parts.reduce((n, p) => n + p.value!, 0);
    if (parts.length >= 3 && close(sum, total.value!)) {
      for (const p of [...parts, total]) mark(p, "confirms", `Checked: the costs read add up to the stated total cost of ${money(total.value!)}`);
    }
    // Several independent parts provide evidence of a total printed at another scale.
    const totalScale = parts.length >= 3 && scale(total.value!, sum) && (total.value! > sum || parts.filter(p => p.value! > total.value!).length >= 3);
    if (totalScale) questionScale(total, sum);
    for (const p of parts) {
      const remainder = total.value! - (sum - p.value!);
      if (!totalScale && parts.length >= 3 && scale(p.value!, remainder)) questionScale(p, remainder);
      else if (!totalScale && p.value! > total.value! && !close(p.value!, total.value!)) mark(p, "questions", `Please check: this is more than the stated total cost of ${money(total.value!)}`);
    }
    const loan = whole("senior_loan_amount"), ltc = whole("stated_ltc_pct");
    if (loan && ltc) {
      const expected = total.value! * ltc.value! / 100;
      if (scale(loan.value!, expected)) {
        const impliedTotal = loan.value! * 100 / ltc.value!;
        if (parts.length >= 3 && close(sum, impliedTotal)) questionScale(total, impliedTotal);
        else questionScale(loan, expected);
      } else if (loan.value! > total.value! && !close(loan.value!, total.value!)) mark(loan, "questions", `Please check: this is more than the stated total cost of ${money(total.value!)}`);
      else if (total.value! > 0 && Math.abs(loan.value! / total.value! * 100 - ltc.value!) <= 1) {
        for (const p of [loan, ltc]) mark(p, "confirms", `Checked: the loan and total cost agree with the stated loan-to-cost of ${ltc.value}%`);
      }
    }
  }
  const count = whole("unit_count"), types = eligible.filter(p => p.fieldKey === "unit_count" && p.itemKey !== null);
  if (count && types.length) {
    const sum = types.reduce((n, p) => n + p.value!, 0);
    if (sum === count.value) mark(count, "confirms", `Checked: the unit types read add up to the stated total of ${count.value}`);
    else mark(count, "questions", `Please check: the unit types read add up to ${sum}, the documents state ${count.value}`);
  }
  return out;
}

/** Choose only a unique closing interpretation of an otherwise unlabelled figure. */
export function chooseByArithmetic(proposals: Proposal[], figures: SourcedCandidate[]): SourcedCandidate[] {
  const before = checkArithmetic(proposals);
  return figures.flatMap(figure => {
    if (figure.fieldKey !== null || figure.value === null || figure.alternatives?.length !== 2 || new Set(figure.alternatives).size !== 2) return [];
    const choices = figure.alternatives.flatMap(fieldKey => {
      if (proposals.some(p => p.fieldKey === fieldKey)) return [];
      const candidate = { ...figure, fieldKey, itemKey: null, rule: "arithmetic-choice" };
      const trial: Proposal = { fieldKey, itemKey: null, status: "needs_review", value: figure.value, sources: [candidate], values: [{ value: figure.value!, sources: [candidate] }], foreign: [], reason: null };
      const checked = checkArithmetic([...proposals, trial]);
      const result = checked.at(-1)!;
      if (result.check?.outcome !== "confirms" || checked.slice(0, -1).some((p, i) => p.check?.outcome === "questions" && before[i]?.check?.outcome !== "questions")) return [];
      return [{ ...candidate, note: `Chosen because it closes: ${result.check.note.replace(/^Checked: /, "")}` }];
    });
    return choices.length === 1 ? choices : [];
  });
}
