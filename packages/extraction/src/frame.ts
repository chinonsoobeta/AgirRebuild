import { FIELD_TABLE, FIELD_BY_KEY, type FieldRow } from "@agir/contracts";
import type { NumberToken } from "@agir/numbers";
import type { Region } from "./candidates.ts";
import { foldText, normalizeLabel, scopeIn, type MapOptions } from "./mapping.ts";
import { LOAN_NOUN, SENIOR_RANK, LENDING_WORD, PRICE_WORD, REPAYMENT_WORD, IO_WORD, OTHER_LENDER, DECLINED_AFTER, LENDER_TEST, OTHER_RATE, LOAN_PERIOD, NOT_SENIOR_LENDER, LOAN_SLOTS, PLAIN_LOAN_WORDS } from "./slot-words.ts";

export type Frame = {
  type: FieldRow["type"] | null;
  subject: string | null;
  attribute: FieldRow["attribute"] | null;
  whose: "this_deal" | "other_lender" | "past" | "limit" | "scenario" | "range" | "declined" | "proposed";
  item: string | null;
  region: Region | undefined;
  refusal: string | null;
};

export function frameFigure(rawLabel: string, token: NumberToken, opts: MapOptions = {}): Frame {
  const { label, labelUnit } = normalizeLabel(rawLabel);
  const unit = token.unit ?? labelUnit;
  const type: Frame["type"] = unit === "$" || token.currency ? "money" : unit === "%" || unit === "bps" ? "percent" : unit === "x" ? "ratio" : unit === "years" || unit === "months" ? unit : unit === "units" ? "count" : unit === "sf" || unit === "m2" ? "area" : unit === "$/sf" || unit === "$/m2" ? "money_per_area" : null;
  const scope = scopeIn(label, false);
  let subject = scope === "mezzanine" ? "second" : scope ?? (SENIOR_RANK.test(label) || LOAN_NOUN.test(label) || opts.loanContext ? "senior" : null);
  let attribute: Frame["attribute"] = null;
  if (LOAN_SLOTS.ltc.test(label)) { subject = "deal"; attribute = "ltc"; }
  else if (LOAN_SLOTS.coverage.test(label) && LOAN_SLOTS.covenant.test(label)) { subject = "deal"; attribute = "coverage"; }
  else if (LOAN_SLOTS.ltv.test(label)) attribute = "ltv";
  else if (IO_WORD.test(label) || LOAN_PERIOD.test(label) && LOAN_SLOTS.principalPeriod.test(label)) attribute = "interest_only";
  else if (REPAYMENT_WORD.test(label)) attribute = "amortization";
  else if (LOAN_SLOTS.term.test(label)) attribute = "term";
  else if (PRICE_WORD.test(label)) attribute = "rate";
  else if (LENDING_WORD.test(label) || LOAN_SLOTS.amount.test(label)) attribute = "amount";
  const frame: Frame = { type, subject, attribute, whose: "this_deal", item: null, region: opts.region, refusal: null };
  const own = foldText(`${rawLabel} ${(opts.after ?? "").split(/[,;.]|\b(?:and|et)\b/)[0] ?? ""}`);
  if (OTHER_LENDER.test(own) || DECLINED_AFTER.test(foldText(opts.after ?? ""))) {
    frame.whose = LOAN_SLOTS.declined.test(own) || DECLINED_AFTER.test(foldText(opts.after ?? "")) ? "declined" : "other_lender";
    frame.refusal = "Another lender's, declined or historical figure, not this deal's funding";
  } else if (subject === "senior" && NOT_SENIOR_LENDER.test(label)) frame.refusal = "An equity or vendor lender, not the senior loan";
  else if (LENDER_TEST.test(label) && attribute !== "coverage") { frame.whose = "limit"; frame.refusal = "A lender's limit, not the deal's figure"; }
  else if (attribute === "rate" && OTHER_RATE.test(own)) frame.refusal = "Another kind of rate, not the loan's price";
  else if (attribute === "amortization" && LOAN_SLOTS.amortizationTerm.test(label)) frame.refusal = "A loan's term, not its amortization";
  // A generic loan noun cannot establish rank without the document's loan context.
  if ((!frame.refusal || !OTHER_LENDER.test(own)) && subject === "senior" && !scope && !SENIOR_RANK.test(label)) frame.subject = null;
  // A year or tranche index in a coverage label does not state the deal's covenant.
  if (attribute === "coverage" && (/\d/.test(label) || !LOAN_SLOTS.coverageType.test(label) || opts.scope === "mezzanine" || opts.conceptScope === "mezzanine")) frame.attribute = null;
  // Only a plain label made entirely of slot words is safe without the old rules.
  // Extra prose, indexes and qualifications stay with the existing reader.
  let remainder = label.replace(LOAN_SLOTS.plainAttributes, " ");
  for (const words of PLAIN_LOAN_WORDS) {
    remainder = remainder.replace(words, " ");
  }
  remainder = remainder.replace(LOAN_SLOTS.plainSubjects, " ").replace(/[- /]/g, "");
  if (remainder) frame.subject = null;
  return frame;
}

export function nameFigure(frame: Frame): { fieldKey: string } | { refused: string } | null {
  if (!frame.subject || !frame.attribute) return null;
  if (frame.refusal) return { refused: frame.refusal };
  const row = FIELD_TABLE.find(row => row.subject === frame.subject && row.attribute === frame.attribute && row.type === frame.type);
  return row && FIELD_BY_KEY.get(row.fieldKey)?.extractable ? { fieldKey: row.fieldKey } : null;
}
