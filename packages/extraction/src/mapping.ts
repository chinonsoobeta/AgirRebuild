// Mapping a label and a number onto a field. Deterministic: label aliases,
// unit compatibility and nothing else. A number that fits no field, or that
// sits next to an output figure, is kept as unmapped so the analyst can see it,
// but it never becomes an input.

import { FIELD_BY_KEY, FIELDS, OUTPUT_LIKE_PHRASES, type FieldDef } from "@agir/contracts";
import { SF_PER_M2, type NumberToken } from "@agir/numbers";

export type LabelUnit = "$" | "%" | "months" | "years" | "sf" | "m2" | "x" | null;

export type Mapped =
  | { kind: "field"; fieldKey: string; itemKey: string | null; value: number; unitSeen: string }
  | { kind: "ignored"; reason: string }
  | { kind: "unmapped" };

// Words that describe a figure rather than name a revenue component.
const GENERIC = new Set([
  "stabilized", "stabilised", "economic", "physical", "lender", "average", "avg", "annual", "total", "overall",
  "project", "portfolio", "minimum", "min", "target", "market", "gross", "net", "blended", "monthly", "base", "the",
  "of", "per", "unit", "all", "in", "place", "in-place", "asking", "effective", "current", "residential rental",
]);

const ITEMIZED_ALIASES: Record<string, string[]> = {
  unit_count: ["rental units", "units", "unit count", "homes", "suites", "apartments", "doors"],
  unit_rent_monthly: ["rent", "monthly rent", "rent per unit", "market rent"],
  rent_psf_annual: ["rent", "rent psf", "rent per sf", "base rent"],
  rentable_area_sf: ["area", "rentable area", "leasable area", "gla", "nrsf", "square feet", "sf"],
  item_occupancy_pct: ["occupancy"],
};

export function normalizeLabel(raw: string): { label: string; labelUnit: LabelUnit } {
  let labelUnit: LabelUnit = null;
  const paren = raw.match(/\(([^)]*)\)/g) ?? [];
  for (const p of paren) {
    const inner = p.slice(1, -1).trim().toLowerCase();
    if (/^(\$|usd|cad|dollars)$/.test(inner)) labelUnit = "$";
    else if (/^(%|percent|pct)$/.test(inner)) labelUnit = "%";
    else if (/^(months?|mos?)$/.test(inner)) labelUnit = "months";
    else if (/^(years?|yrs?)$/.test(inner)) labelUnit = "years";
    else if (/^(sf|sq\.? ?ft|square feet|pi²|pi2|pi\.? ?ca\.?)$/.test(inner)) labelUnit = "sf";
    else if (/^(m²|m2|sq\.? ?m|sqm|square met(re|er)s)$/.test(inner)) labelUnit = "m2";
    else if (/^x$/.test(inner)) labelUnit = "x";
  }
  const label = raw
    .replace(/\([^)]*\)/g, " ")
    .replace(/²/g, "2")
    .toLowerCase()
    .replace(/[^a-z0-9/#$%&\s-]/g, " ")
    .replace(/\b(is|are|of|at|to|was|will be|approximately|approx|about)\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { label, labelUnit };
}

function hasPhrase(label: string, phrase: string): boolean {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(label);
}

function endsWithPhrase(label: string, phrase: string): string | null {
  if (label === phrase) return "";
  if (label.endsWith(" " + phrase)) return label.slice(0, -phrase.length - 1).trim();
  return null;
}

function itemName(prefix: string): string {
  const words = prefix.split(" ").filter((w) => w && !GENERIC.has(w));
  if (words.length === 0 || words.length > 4) return "";
  return words.map((w) => (/^\d/.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join(" ");
}

/**
 * Convert a token to the field's canonical unit, or return null if they are not
 * compatible. Areas are canonical in square feet: m² is converted here, and
 * unitSeen keeps the unit the document used (decision 7).
 */
function compatibleValue(def: FieldDef, t: NumberToken, label: string, labelUnit: LabelUnit): { value: number; unitSeen: string } | null {
  const v = t.value;
  if (v === null) return null;
  const u = t.unit;
  switch (def.unit) {
    case "$":
      if (u === "$" || labelUnit === "$") return { value: v, unitSeen: "$" };
      if (u === null && Math.abs(v) >= 1000) return { value: v, unitSeen: "number" };
      return null;
    case "%":
      if (u === "%" || (u === null && labelUnit === "%")) return { value: v, unitSeen: "%" };
      return null;
    case "months":
      if (u === "months" || (u === null && labelUnit === "months")) return { value: v, unitSeen: "months" };
      if (u === "years" || (u === null && labelUnit === "years")) return { value: v * 12, unitSeen: "years" };
      return null;
    case "years":
      if (u === "years" || (u === null && labelUnit === "years")) return { value: v, unitSeen: "years" };
      if (u === "months" && Number.isInteger(v / 12)) return { value: v / 12, unitSeen: "months" };
      return null;
    case "units":
      if (u === "units") return { value: v, unitSeen: "units" };
      if (u === null && labelUnit === null && Number.isInteger(v) && v > 0) return { value: v, unitSeen: "number" };
      return null;
    case "sf":
      if (u === "sf" || (u === null && labelUnit === "sf")) return { value: v, unitSeen: "sf" };
      if (u === "m2" || (u === null && labelUnit === "m2")) return { value: v * SF_PER_M2, unitSeen: "m2" };
      if (u === null && labelUnit === null && hasPhrase(label, "area") && v >= 100) return { value: v, unitSeen: "number" };
      return null;
    case "$/unit/mo":
      if (u === "$/mo") return { value: v, unitSeen: "$/mo" };
      if (u === "$" && /\b(monthly|per month|per unit)\b/.test(label)) return { value: v, unitSeen: "$" };
      return null;
    case "$/sf/yr":
      if (u === "$/sf") return { value: v, unitSeen: "$/sf" };
      if (u === "$/m2") return { value: v / SF_PER_M2, unitSeen: "$/m2" };
      if ((u === "$" || u === null) && /\b(psf|per sf|\/sf|per square foot)\b/.test(label)) return { value: v, unitSeen: "$" };
      if ((u === "$" || u === null) && /\b(psm|per m2|\/m2|per sq m|per square met(re|er))\b/.test(label)) return { value: v / SF_PER_M2, unitSeen: "$/m2" };
      return null;
    case "x":
      if (u === "x") return { value: v, unitSeen: "x" };
      if (u === null && (labelUnit === "x" || hasPhrase(label, "dscr"))) return { value: v, unitSeen: "number" };
      return null;
    default:
      return null;
  }
}

/** Map one labelled number onto a field. */
export function mapToken(rawLabel: string, t: NumberToken): Mapped {
  const { label, labelUnit } = normalizeLabel(rawLabel);
  const output = OUTPUT_LIKE_PHRASES.find((p) => hasPhrase(label, p));
  if (output) return { kind: "ignored", reason: `"${rawLabel.trim()}" is an output figure, which is never taken as an input` };
  if (t.value === null) return { kind: "ignored", reason: t.refusal ?? "The number could not be read without guessing" };

  // Scalars: longest alias found anywhere in the label, among compatible fields.
  let best: { def: FieldDef; alias: string; value: number; unitSeen: string } | null = null;
  let aliasOnly: { def: FieldDef; alias: string } | null = null;
  for (const def of FIELDS) {
    if (def.itemized || !def.extractable) continue;
    for (const alias of def.aliases) {
      if (!hasPhrase(label, alias)) continue;
      const c = compatibleValue(def, t, label, labelUnit);
      if (!c) {
        if (!aliasOnly || alias.length > aliasOnly.alias.length) aliasOnly = { def, alias };
        continue;
      }
      if (best && alias.length <= best.alias.length) continue;
      best = { def, alias, ...c };
    }
  }
  // Itemized: an alias at the end of the label, with a component name before it.
  let item: { def: FieldDef; alias: string; itemKey: string; value: number; unitSeen: string } | null = null;
  for (const def of FIELDS) {
    if (!def.itemized) continue;
    for (const alias of ITEMIZED_ALIASES[def.key] ?? []) {
      const prefix = endsWithPhrase(label, alias);
      if (prefix === null) continue;
      const name = itemName(prefix);
      const c = compatibleValue(def, t, label, labelUnit);
      if (!c) continue;
      if (!item || alias.length > item.alias.length || (name && !item.itemKey)) {
        item = { def, alias, itemKey: name, ...c };
      }
    }
  }
  if (item && item.itemKey && (!best || item.alias.length >= best.alias.length)) {
    return { kind: "field", fieldKey: item.def.key, itemKey: item.itemKey, value: item.value, unitSeen: item.unitSeen };
  }
  if (best) return { kind: "field", fieldKey: best.def.key, itemKey: null, value: best.value, unitSeen: best.unitSeen };
  if (item) {
    return { kind: "field", fieldKey: item.def.key, itemKey: "All units", value: item.value, unitSeen: item.unitSeen };
  }
  // A component named by itself with a self-describing unit: "Retail: 9,000 SF".
  const name = itemName(label);
  if (name && label.split(" ").length <= 3) {
    const byUnit: Record<string, string> = {
      units: "unit_count",
      sf: "rentable_area_sf",
      m2: "rentable_area_sf",
      "$/mo": "unit_rent_monthly",
      "$/sf": "rent_psf_annual",
      "$/m2": "rent_psf_annual",
    };
    const key = t.unit ? byUnit[t.unit] : undefined;
    const c = key ? compatibleValue(FIELD_BY_KEY.get(key)!, t, label, labelUnit) : null;
    if (key && c) return { kind: "field", fieldKey: key, itemKey: name, value: c.value, unitSeen: c.unitSeen };
  }
  if (aliasOnly) {
    const want: Record<string, string> = {
      "%": "a % sign",
      "$": "a dollar amount",
      months: "months",
      years: "years",
      x: "an x multiple",
      sf: "square feet or square metres",
      units: "a unit count",
    };
    return {
      kind: "ignored",
      reason: `Looks like ${aliasOnly.def.label.toLowerCase()}, but the number is not written as ${want[aliasOnly.def.unit] ?? aliasOnly.def.unit}. Enter it by hand if it is.`,
    };
  }
  return { kind: "unmapped" };
}
