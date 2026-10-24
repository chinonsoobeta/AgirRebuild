import { FIELD_BY_KEY, type FieldDef } from "./fields.ts";

export type FieldRow = {
  subject: string;
  attribute: "amount" | "rate" | "amortization" | "term" | "interest_only" | "ltv" | "ltc" | "coverage" | "share" | "limit" | "total";
  type: "money" | "percent" | "years" | "months" | "count" | "area" | "money_per_area" | "ratio";
  fieldKey: string;
  window: FieldDef["window"];
};

export const FIELD_TABLE: readonly FieldRow[] = [
  { subject: "senior", attribute: "amount", type: "money", fieldKey: "senior_loan_amount" },
  { subject: "senior", attribute: "rate", type: "percent", fieldKey: "senior_rate_pct" },
  { subject: "senior", attribute: "amortization", type: "years", fieldKey: "senior_amort_years" },
  { subject: "senior", attribute: "interest_only", type: "months", fieldKey: "senior_io_months" },
  { subject: "second", attribute: "amount", type: "money", fieldKey: "mezz_loan_amount" },
  { subject: "second", attribute: "rate", type: "percent", fieldKey: "mezz_rate_pct" },
  { subject: "second", attribute: "amortization", type: "years", fieldKey: "mezz_amort_years" },
  { subject: "second", attribute: "interest_only", type: "months", fieldKey: "mezz_io_months" },
  { subject: "refinance", attribute: "amount", type: "money", fieldKey: "refinance_amount" },
  { subject: "refinance", attribute: "rate", type: "percent", fieldKey: "refinance_rate_pct" },
  { subject: "refinance", attribute: "amortization", type: "years", fieldKey: "refinance_amort_years" },
  { subject: "refinance", attribute: "interest_only", type: "months", fieldKey: "refinance_io_months" },
  { subject: "deal", attribute: "coverage", type: "ratio", fieldKey: "min_dscr_covenant" },
  { subject: "refinance", attribute: "ltv", type: "percent", fieldKey: "refinance_ltv_pct" },
  { subject: "refinance", attribute: "term", type: "years", fieldKey: "refinance_term_years" },
  { subject: "deal", attribute: "ltc", type: "percent", fieldKey: "stated_ltc_pct" },
].map(row => ({ ...row, window: FIELD_BY_KEY.get(row.fieldKey)!.window })) as FieldRow[];
