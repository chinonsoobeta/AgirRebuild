import { FIELD_BY_KEY } from "@agir/contracts";
import { detectFormat, tokenize, type DocumentFormat, type NumberToken } from "@agir/numbers";
import type { Cell, NormalizedDocument, Table } from "./document.ts";
import { mapToken, normalizeLabel } from "./mapping.ts";

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

type Roles = { item: number[]; units?: number; rent?: number; basis?: number; area?: number; occupancy?: number; psfHeader: boolean };

function rentRollRoles(header: Cell[]): Roles | null {
  const roles: Roles = { item: [], psfHeader: false };
  header.forEach((c, i) => {
    const h = c.text.toLowerCase();
    if (!h) return;
    if (/\b(unit\s*type|type|component|space|tenant|suite|plan|floor\s*plan|use)\b/.test(h)) roles.item.push(i);
    else if (/\b(units|unit count|count|#|doors)\b/.test(h)) roles.units = i;
    else if (/\brent\b/.test(h) && !/basis/.test(h)) {
      roles.rent = i;
      roles.psfHeader = /(psf|\/\s?sf|per sf)/.test(h);
    } else if (/basis/.test(h)) roles.basis = i;
    else if (/\b(area|sf|nrsf|rsf|gla|square feet)\b/.test(h)) roles.area = i;
    else if (/occupancy|occ\b/.test(h)) roles.occupancy = i;
  });
  return roles.item.length > 0 && roles.rent !== undefined && (roles.units !== undefined || roles.area !== undefined) ? roles : null;
}

function budgetRoles(header: Cell[]): { label: number; amount: number } | null {
  let label = -1;
  let amount = -1;
  header.forEach((c, i) => {
    const h = c.text.toLowerCase();
    if (label < 0 && /\b(line\s*item|description|category|item|cost\s*item|use)\b/.test(h)) label = i;
    else if (amount < 0 && /\b(amount|cost|budget|total|\$)\b/.test(h)) amount = i;
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
    const basisText = roles.basis !== undefined ? (row[roles.basis]?.text ?? "").toLowerCase() : "";
    const psf = roles.psfHeader || /sf|psf/.test(basisText);
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
      if (def.unit === "%" && t.unit !== "%" && value <= 1 && cell.number !== undefined) value = value * 100;
      result.candidates.push({ fieldKey, itemKey, value, raw: t.raw, unitSeen: t.unit, location: cell.ref, context: `${table.name}: ${itemText}`, rule: "table:rent-roll" });
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
  const components = new Map<string, { sum: number; refs: string[]; labels: string[] }>();
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
      unitSeen: "$",
      location: amountCell.ref,
      context: `${table.name}: ${labelCell.text}`,
      rule: isTotal ? "table:budget-total" : "table:budget",
    };
    if (isTotal && mapped.fieldKey !== "stated_total_cost") {
      totals.push(cand);
      continue;
    }
    const acc = components.get(mapped.fieldKey) ?? { sum: 0, refs: [], labels: [] };
    acc.sum += mapped.value;
    acc.refs.push(amountCell.ref);
    acc.labels.push(labelCell.text);
    components.set(mapped.fieldKey, acc);
  }
  for (const [fieldKey, acc] of components) {
    result.candidates.push({
      fieldKey,
      itemKey: null,
      value: acc.sum,
      raw: acc.sum.toString(),
      unitSeen: "$",
      location: acc.refs.join(", "),
      context: `${table.name}: ${acc.labels.join(" + ")}`,
      rule: acc.refs.length > 1 ? "table:budget-sum" : "table:budget",
    });
  }
  for (const t of totals) {
    const comp = components.get(t.fieldKey!);
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
    const k = `${c.fieldKey}|${c.itemKey}|${c.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return result;
}

export { normalizeLabel };
