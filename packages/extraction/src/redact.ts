import type { Cell, Line, NormalizedDocument } from "./document.ts";

// Card S7 (ADR 0002 §5): before the text of a document leaves for the model, patterns that are never a deal figure are
// replaced by a marker. Precision over recall: a figure removed by mistake is far worse than a phone number kept, so
// every rule refuses digits that have a currency mark, a percent sign or a unit beside them. Names are not removed:
// no rule tells a tenant's name from a street's or a company's.

export type RedactionKind = "email" | "phone" | "sin" | "card" | "postal_code" | "account" | "date_of_birth";
export type Redaction = { kind: RedactionKind; count: number };
export type RedactedSpan = { start: number; end: number; kind: RedactionKind };

/** The order a kind is tried in: an earlier kind wins a span two kinds match. */
const KINDS: RedactionKind[] = ["email", "card", "sin", "phone", "account", "postal_code", "date_of_birth"];

/** What replaces a span; it holds no digit, so it is never read as a figure. */
export const redactionMarker = (kind: RedactionKind) => `[redacted ${kind.replace(/_/g, " ")}]`;

// Digits glued to a letter, a figure's separator, a slash, a sign or another digit group are part of something else.
const START = String.raw`(?<![\p{L}\p{N}_.,/$€£+-])(?<!\p{N}[ .-])`;
const END = String.raw`(?![\p{N}]|[.,]\p{N}|[ -]\p{N})`;
// A currency mark or word before the digits, or a currency, percent or unit after them, makes them a figure: kept.
const FIGURE_BEFORE = /(?:[$€£]|(?<!\p{L})(?:USD|CAD|dollars?))\s*$/iu;
const FIGURE_AFTER = /^\s*(?:[$€£%]|(?:USD|CAD|dollars?|sf|psf|sq\.?\s?ft\.?|square\s+(?:feet|foot)|pi²|pi2|pi\.?\s?ca\.?|pieds?\s+carrés?|m²|m2|sqm|units?|unités?|logements?|suites?|doors|months?|mois|years?|yrs?|ans?|k|mm?|millions?|thousands?|bn|billions?)(?![\p{L}\p{N}]))/iu;
const isFigure = (text: string, start: number, end: number) => FIGURE_BEFORE.test(text.slice(0, start)) || FIGURE_AFTER.test(text.slice(end));

const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}])/gu;
// "(416) 555-1234", "416-555-1234", "416.555.1234", with "+1" or "1-" and an extension; never digits without separators.
const PHONE = new RegExp(String.raw`${START}(?:\+1[\s.-]?|1-)?(?:\(\d{3}\)\s?\d{3}[-.]\d{4}|\d{3}([-.])\d{3}\1\d{4})(?:\s*(?:x|ext\.?|extension|poste)\s*\d{1,6})?${END}`, "giu");
const SIN = new RegExp(String.raw`${START}\d{3}([- ])\d{3}\1\d{3}${END}`, "gu");
const SIN_NAMED = /(?<![\p{L}])(?:SIN|NAS|S\.I\.N\.?|N\.A\.S\.?)(?![\p{L}])/u;
const SIN_PHRASE = /social\s+insurance|assurance\s+sociale/i;
// Groups of four (Visa, Mastercard), 4-6-5 (Amex) or one run of 13 to 19 digits.
const CARD = new RegExp(String.raw`${START}(?:\d{4}([ -])\d{4}\1\d{4}\1\d{1,4}(?:\1\d{1,3})?|\d{4}([ -])\d{6}\2\d{4,5}|\d{13,19})${END}`, "gu");
const POSTAL = /(?<![\p{L}\p{N}])[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d(?![\p{L}\p{N}])/gu;
const ZIP = new RegExp(String.raw`${START}\d{5}(?:-\d{4})?${END}`, "gu");
const ZIP_NAMED = /(?<![\p{L}])zip(?![\p{L}])/iu;
const ACCOUNT = new RegExp(String.raw`${START}(?:\d{7,}|\d+(?:-\d+)+)${END}`, "gu");
const ACCOUNT_WORD = /(?<![\p{L}])(?:account|acct|compte|transit|iban|routing)(?![\p{L}])/giu;
// Between the word and the number only "number", "no.", "#", "bank" or a colon: "Account no. 1234567", "Compte : 1234567".
const ACCOUNT_GAP = /^\s*(?:(?:number|no\.?|num(?:[ée]ro)?\.?|#|n°|nº|bank|bancaire|de\s+banque)\s*)*[:#.]?\s*$/iu;
// A line about an account's money ("Reserve account: 2500000", "Solde du compte : 1250000") holds a figure, not a number to hide.
const ACCOUNT_MONEY = /(?<![\p{L}])(?:balance|solde|reserves?|r[ée]serves?|funds?|fonds|deposits?|d[ée]p[ôo]ts?|payable|receivable|recevables?|amount|montant)(?![\p{L}])/iu;
const BIRTH_NAMED = /(?<![\p{L}])(?:birth|naissance|DOB|D\.O\.B)(?![\p{L}])/giu;
const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre";
const DATE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|(?:${MONTH})\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:er|st|nd|rd|th)?\s+(?:${MONTH})\.?,?\s+\d{4})(?![\p{L}\p{N}])`, "giu");

/** The Luhn check that card numbers and social insurance numbers carry. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * The spans of `text` to remove, in the text's own offsets. `prefix` is what comes before it on the same line (the cells
 * before a cell in its row), so "SIN" in one cell names the number in the next.
 */
export function redactionSpans(text: string, prefix = ""): RedactedSpan[] {
  const line = prefix ? `${prefix} ${text}` : text;
  const found: Record<RedactionKind, RedactedSpan[]> = { email: [], card: [], sin: [], phone: [], account: [], postal_code: [], date_of_birth: [] };
  const each = (re: RegExp, kind: RedactionKind, keep: (m: RegExpMatchArray) => boolean) => {
    for (const m of text.matchAll(re)) if (keep(m)) found[kind].push({ start: m.index!, end: m.index! + m[0].length, kind });
  };
  const digits = (s: string) => s.replace(/\D/g, "");
  const plain = (m: RegExpMatchArray) => !isFigure(text, m.index!, m.index! + m[0].length);
  each(EMAIL, "email", () => true);
  each(CARD, "card", m => plain(m) && digits(m[0]).length >= 13 && digits(m[0]).length <= 19 && luhn(digits(m[0])));
  // A space-grouped nine-digit group is also how French writes an amount, so it is removed only when the line names it.
  const sinNamed = SIN_NAMED.test(line) || SIN_PHRASE.test(line);
  each(SIN, "sin", m => plain(m) && (sinNamed || (m[1] === "-" && luhn(digits(m[0])))));
  each(PHONE, "phone", plain);
  each(ACCOUNT, "account", m => {
    if (!plain(m) || digits(m[0]).length < 7 || /^\d{4}-\d{1,2}-\d{1,2}$/.test(m[0])) return false;
    const before = (prefix ? `${prefix} ` : "") + text.slice(0, m.index!);
    const word = [...before.matchAll(ACCOUNT_WORD)].at(-1);
    return Boolean(word) && ACCOUNT_GAP.test(before.slice(word!.index! + word![0].length)) && !ACCOUNT_MONEY.test(line);
  });
  each(POSTAL, "postal_code", () => true);
  if (ZIP_NAMED.test(line)) each(ZIP, "postal_code", plain);
  // The date right after the word, so "born 1980-05-12; closing 2026-10-30" keeps the closing date.
  each(DATE, "date_of_birth", m => {
    const before = (prefix ? `${prefix} ` : "") + text.slice(0, m.index!);
    const word = [...before.matchAll(BIRTH_NAMED)].at(-1);
    return Boolean(word) && !/\p{N}/u.test(before.slice(word!.index! + word![0].length));
  });
  // An earlier kind wins: an email's digits are not also a phone number.
  const spans: RedactedSpan[] = [];
  for (const kind of KINDS) {
    for (const s of found[kind]) if (!spans.some(o => s.start < o.end && o.start < s.end)) spans.push(s);
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** `text` with each span replaced by its marker, and a map from an offset in `text` to one in the result. */
function apply(text: string, spans: RedactedSpan[]) {
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + redactionMarker(s.kind);
    at = s.end;
  }
  out += text.slice(at);
  // An offset inside a span moves to the marker's start (a range's start) or end (a range's end).
  const shift = (p: number, end: boolean) => {
    let delta = 0;
    for (const s of spans) {
      const length = redactionMarker(s.kind).length;
      if (p >= s.end) delta += length - (s.end - s.start);
      else if (p > s.start) return s.start + delta + (end ? length : 0);
      else break;
    }
    return p + delta;
  };
  return { text: out, shift };
}

export function redactText(text: string, prefix = ""): { text: string; spans: RedactedSpan[] } {
  const spans = redactionSpans(text, prefix);
  return { text: apply(text, spans).text, spans };
}

/**
 * The document the model is shown: the same lines, cells and addresses, with each pattern that is never a deal figure
 * replaced by its marker, and how many of each kind went. The rule reader never sees this; it reads the original.
 * `fullText` is kept as it was: it is never sent, only read for the number format, and the boundary must read a figure
 * in the format the rule reader used (a social insurance number's spaces are evidence of space-grouped thousands).
 */
export function redactDocument(doc: NormalizedDocument): { document: NormalizedDocument; redactions: Redaction[] } {
  const counts = new Map<RedactionKind, number>();
  const redact = <T extends Line | Cell>(entry: T, prefix: string): T => {
    // A spreadsheet cell that holds a number is a figure by construction; its text is that number, never redacted.
    if ("number" in entry && entry.number !== undefined) return entry;
    const spans = redactionSpans(entry.text, prefix);
    if (!spans.length) return entry;
    for (const s of spans) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
    const { text, shift } = apply(entry.text, spans);
    const struck = entry.struck?.map(([a, b]) => [shift(a, false), shift(b, true)] as [number, number]).filter(([a, b]) => a < b);
    return { ...entry, text, ...(entry.struck ? { struck } : {}) };
  };
  const document: NormalizedDocument = {
    ...doc,
    lines: doc.lines.map(l => redact(l, "")),
    tables: doc.tables.map(t => ({ ...t, rows: t.rows.map(row => row.map((c, i) => redact(c, row.slice(0, i).map(x => x.text).join(" ")))) })),
  };
  return { document, redactions: KINDS.flatMap(kind => counts.has(kind) ? [{ kind, count: counts.get(kind)! }] : []) };
}
