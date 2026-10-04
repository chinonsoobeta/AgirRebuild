import { FIELD_BY_KEY } from "@agir/contracts";
import { detectFormat, SF_PER_M2, tokenize, type DocumentFormat, type NumberToken } from "@agir/numbers";
import type { Cell, NormalizedDocument, Table } from "./document.ts";
import { currencyOf, mapToken, normalizeLabel, withCurrency } from "./mapping.ts";

/** One value found in one document, with where it came from and why it was (or was not) mapped. */
export type Candidate = {
  fieldKey: string | null;
  itemKey: string | null;
  value: number | null;
  raw: string;
  unitSeen: string | null;
  location: string;
  context: string;
  rule: string;
  note?: string;
};

export type ExtractionResult = {
  format: DocumentFormat;
  candidates: Candidate[];
  /** Numbers found that map to nothing, or that were refused. Shown, never used. */
  other: Candidate[];
};

const TOTAL_RE = /^\s*(grand\s+)?(sub-?\s*)?total\b/i;

function cellToken(cell: Cell, format: DocumentFormat): NumberToken | null {
  if (cell.number !== undefined) {
    return {
      raw: cell.text,
      start: 0,
      end: cell.text.length,
      value: cell.number,
      currency: cell.unit === "$",
      currencyCode: cell.currency ?? null,
      unit: cell.unit === "%" ? "%" : cell.unit === "$" ? "$" : null,
      scaled: false,
    };
  }
  return tokenize(cell.text, format)[0] ?? null;
}

function push(result: ExtractionResult, label: string, token: NumberToken, location: string, context: string, rule: string) {
  const mapped = mapToken(label, token);
  const base = { raw: token.raw, location, context: context.slice(0, 240), rule };
  if (mapped.kind === "field") {
    result.candidates.push({ ...base, fieldKey: mapped.fieldKey, itemKey: mapped.itemKey, value: mapped.value, unitSeen: mapped.unitSeen });
  } else {
    result.other.push({
      ...base,
      fieldKey: null,
      itemKey: null,
      value: token.value,
      unitSeen: token.unit,
      note: mapped.kind === "ignored" ? mapped.reason : "No field matches this label",
    });
  }
}

/** Lines of prose: "Label: value", "Label (unit): value", or "the label is value". */
function fromLines(doc: NormalizedDocument, result: ExtractionResult) {
  for (const line of doc.lines) {
    const tokens = tokenize(line.text, result.format);
    if (tokens.length === 0) continue;
    const colon = line.text.indexOf(":");
    if (colon > 0 && tokens[0]!.start > colon) {
      // Label-first: every number after the colon shares the label. The first
      // number compatible with a field wins; the rest are kept as "other".
      const label = line.text.slice(0, colon);
      let used = false;
      for (const t of tokens) {
        const mapped = used ? { kind: "unmapped" as const } : mapToken(label, t);
        if (!used && mapped.kind === "field") {
          push(result, label, t, line.location, line.text, "line:label-value");
          used = true;
        } else if (!used || t.value !== null) {
          result.other.push({
            fieldKey: null,
            itemKey: null,
            value: t.value,
            raw: t.raw,
            unitSeen: t.unit,
            location: line.location,
            context: line.text.slice(0, 240),
            rule: "line:label-value",
            note: mapped.kind === "ignored" ? mapped.reason : used ? "Another number on this line was used" : "No field matches this label",
          });
        }
      }
      continue;
    }
    // Prose: each number's label is the text since the previous number.
    let from = 0;
    for (const t of tokens) {
      const label = line.text.slice(from, t.start);
      push(result, label, t, line.location, line.text, "line:prose");
      from = t.end;
    }
  }
}

type Roles = {
  item: number[];
  units?: number;
  rent?: number;
  basis?: number;
  area?: number;
  occupancy?: number;
  psfHeader: boolean;
  /** The column headers say the area, or the rent, is per square metre. */
  areaM2: boolean;
  rentPerM2: boolean;
};

// A column header, lower case, "²" written "2" and accents folded ("unité" is "unite"), so "m²" and "m2" read the same.
const headerOf = (c: Cell) => c.text.toLowerCase().replace(/²/g, "2").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const M2_RE = /\b(m2|sq\.? ?m|sqm|square met(re|er)s?)\b/;
const PER_M2_RE = /(psm|\/\s?(m2|sq\.? ?m|sqm)\b|(per|au|par) (m2|sq\.? ?m|sqm|square met(re|er))\b)/;

function rentRollRoles(header: Cell[]): Roles | null {
  const roles: Roles = { item: [], psfHeader: false, areaM2: false, rentPerM2: false };
  header.forEach((c, i) => {
    const h = headerOf(c);
    if (!h) return;
    // French: "Nombre de logements" counts units; "Type de logement" and "Unité" name them; "Loyer par logement" is a rent.
    if (/\b(nombre|nbre|nb|quantite)\b/.test(h)) roles.units = i;
    else if (/\b(unit\s*type|type|component|space|tenant|suite|plan|floor\s*plan|use)\b/.test(h) || (/\b(logement|unite|appartement|locataire|espace|local)\b/.test(h) && !/\bloyer\b/.test(h))) roles.item.push(i);
    else if (/\b(units|unit count|count|#|doors|logements|unites|appartements)\b/.test(h)) roles.units = i;
    else if (/\b(rent|loyer)\b/.test(h) && !/basis/.test(h)) {
      roles.rent = i;
      roles.rentPerM2 = PER_M2_RE.test(h);
      roles.psfHeader = /(psf|\/\s?sf|per sf|(au|par) (pi2|pi\.? ?ca))/.test(h) || roles.rentPerM2;
    } else if (/basis/.test(h)) roles.basis = i;
    else if (/\b(area|sf|nrsf|rsf|gla|square feet|superficie|surface|pi2)\b/.test(h) || M2_RE.test(h)) {
      roles.area = i;
      roles.areaM2 = M2_RE.test(h);
    } else if (/occupancy|occupation|occ\b/.test(h)) roles.occupancy = i;
  });
  return roles.item.length > 0 && roles.rent !== undefined && (roles.units !== undefined || roles.area !== undefined) ? roles : null;
}

function budgetRoles(header: Cell[]): { label: number; amount: number } | null {
  let label = -1;
  let amount = -1;
  header.forEach((c, i) => {
    const h = headerOf(c);
    if (label < 0 && /\b(line\s*item|description|category|item|cost\s*item|use|poste|libelle|designation|categorie|rubrique)\b/.test(h)) label = i;
    else if (amount < 0 && /\b(amount|cost|budget|total|montant|couts?|\$)\b/.test(h)) amount = i;
  });
  return label >= 0 && amount >= 0 ? { label, amount } : null;
}

function fromRentRoll(table: Table, headerRow: number, roles: Roles, result: ExtractionResult) {
  for (let r = headerRow + 1; r < table.rows.length; r++) {
    const row = table.rows[r]!;
    const itemParts = roles.item.map((i) => row[i]?.text ?? "").filter(Boolean);
    const itemText = itemParts.join(" ").trim();
    if (!itemText || itemParts.some((p) => TOTAL_RE.test(p))) continue;
    const itemKey = itemText.replace(/\s+/g, " ");
    const basisText = roles.basis !== undefined ? (row[roles.basis]?.text ?? "").toLowerCase().replace(/²/g, "2") : "";
    const perM2 = roles.rentPerM2 || /psm|m2/.test(basisText);
    const psf = roles.psfHeader || perM2 || /sf|psf/.test(basisText);
    const add = (fieldKey: string, idx: number | undefined) => {
      if (idx === undefined) return;
      const cell = row[idx];
      if (!cell || (!cell.text && cell.number === undefined)) return;
      const t = cellToken(cell, result.format);
      if (!t || t.value === null) {
        if (t) result.other.push({ fieldKey: null, itemKey: null, value: null, raw: t.raw, unitSeen: t.unit, location: cell.ref, context: itemText, rule: "table:rent-roll", note: t.refusal ?? "Unreadable" });
        return;
      }
      const def = FIELD_BY_KEY.get(fieldKey)!;
      let value = t.value;
      let unitSeen: string | null = t.unit && withCurrency(t.unit, t.currencyCode);
      if (def.unit === "%" && t.unit !== "%" && value <= 1 && cell.number !== undefined) value = value * 100;
      // Square metres, stated by the cell or by its column, become square feet (decision 7).
      if (fieldKey === "rentable_area_sf" && (t.unit === "m2" || (t.unit === null && roles.areaM2))) {
        value *= SF_PER_M2;
        unitSeen = "m2";
      }
      if (fieldKey === "rent_psf_annual" && (t.unit === "$/m2" || ((t.unit === null || t.unit === "$") && perM2))) {
        value /= SF_PER_M2;
        unitSeen = withCurrency("$/m2", t.currencyCode);
      }
      result.candidates.push({ fieldKey, itemKey, value, raw: t.raw, unitSeen, location: cell.ref, context: `${table.name}: ${itemText}`, rule: "table:rent-roll" });
    };
    add("unit_count", roles.units);
    add(psf ? "rent_psf_annual" : "unit_rent_monthly", roles.rent);
    if (psf) add("rentable_area_sf", roles.area);
    add("item_occupancy_pct", roles.occupancy);
  }
}

function fromBudget(table: Table, headerRow: number, roles: { label: number; amount: number }, result: ExtractionResult) {
  // Sum component lines per field; use a "Total X" row only when no component
  // line mapped to X, and raise both when they disagree.
  // A line in another currency is never added to the deal's own: sums are kept per field and currency.
  const components = new Map<string, { fieldKey: string; unitSeen: string; sum: number; refs: string[]; labels: string[] }>();
  const totals: Candidate[] = [];
  for (let r = headerRow + 1; r < table.rows.length; r++) {
    const row = table.rows[r]!;
    const labelCell = row[roles.label];
    const amountCell = row[roles.amount];
    if (!labelCell?.text || !amountCell) continue;
    const t = cellToken(amountCell, result.format);
    if (!t) continue;
    const isTotal = TOTAL_RE.test(labelCell.text);
    const labelText = isTotal ? labelCell.text.replace(TOTAL_RE, "").trim() || labelCell.text : labelCell.text;
    const moneyToken: NumberToken = { ...t, currency: true, unit: t.unit ?? "$" };
    const mapped = mapToken(isTotal && /development|project/i.test(labelCell.text) ? labelCell.text : labelText, moneyToken);
    if (mapped.kind !== "field" || FIELD_BY_KEY.get(mapped.fieldKey)?.unit !== "$") {
      result.other.push({
        fieldKey: null,
        itemKey: null,
        value: t.value,
        raw: t.raw,
        unitSeen: "$",
        location: amountCell.ref,
        context: `${table.name}: ${labelCell.text}`,
        rule: "table:budget",
        note: mapped.kind === "ignored" ? mapped.reason : "No budget line matches this label",
      });
      continue;
    }
    const cand: Candidate = {
      fieldKey: mapped.fieldKey,
      itemKey: null,
      value: mapped.value,
      raw: t.raw,
      unitSeen: withCurrency("$", t.currencyCode ?? currencyOf(mapped.unitSeen)),
      location: amountCell.ref,
      context: `${table.name}: ${labelCell.text}`,
      rule: isTotal ? "table:budget-total" : "table:budget",
    };
    if (isTotal && mapped.fieldKey !== "stated_total_cost") {
      totals.push(cand);
      continue;
    }
    const ck = `${mapped.fieldKey}|${cand.unitSeen}`;
    const acc = components.get(ck) ?? { fieldKey: mapped.fieldKey, unitSeen: cand.unitSeen!, sum: 0, refs: [], labels: [] };
    acc.sum += mapped.value;
    acc.refs.push(amountCell.ref);
    acc.labels.push(labelCell.text);
    components.set(ck, acc);
  }
  for (const acc of components.values()) {
    result.candidates.push({
      fieldKey: acc.fieldKey,
      itemKey: null,
      value: acc.sum,
      raw: acc.sum.toString(),
      unitSeen: acc.unitSeen,
      location: acc.refs.join(", "),
      context: `${table.name}: ${acc.labels.join(" + ")}`,
      rule: acc.refs.length > 1 ? "table:budget-sum" : "table:budget",
    });
  }
  for (const t of totals) {
    const comp = components.get(`${t.fieldKey}|${t.unitSeen}`);
    if (!comp) result.candidates.push(t);
    else if (Math.abs(comp.sum - (t.value ?? 0)) > 0.5) {
      result.candidates.push({ ...t, note: `The subtotal disagrees with its lines (${comp.sum.toLocaleString("en-US")})` });
    }
  }
}

function fromTable(table: Table, result: ExtractionResult) {
  for (let r = 0; r < Math.min(table.rows.length, 12); r++) {
    const header = table.rows[r]!;
    const rr = rentRollRoles(header);
    if (rr) return fromRentRoll(table, r, rr, result);
    const br = budgetRoles(header);
    if (br) return fromBudget(table, r, br, result);
  }
  // A plain two-column sheet: each row is "label: value".
  table.rows.forEach((row) => {
    const labelCell = row.find((c) => c.text && c.number === undefined && !/^[\d$(.,\s%-]+$/.test(c.text));
    if (!labelCell) return;
    const after = row.slice(row.indexOf(labelCell) + 1);
    for (const cell of after) {
      const t = cellToken(cell, result.format);
      if (t) {
        push(result, labelCell.text, t, cell.ref, `${table.name}: ${labelCell.text} ${cell.text}`, "table:label-value");
        break;
      }
    }
  });
}

/** Every candidate value in one document. Deterministic: no model is consulted. */
export function extractCandidates(doc: NormalizedDocument): ExtractionResult {
  const result: ExtractionResult = { format: detectFormat(doc.fullText), candidates: [], other: [] };
  fromLines(doc, result);
  for (const t of doc.tables) fromTable(t, result);
  // Within one document, the same field and value found twice is one candidate.
  const seen = new Set<string>();
  result.candidates = result.candidates.filter((c) => {
    const k = `${c.fieldKey}|${c.itemKey}|${c.value}|${currencyOf(c.unitSeen)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return result;
}

export { normalizeLabel };
