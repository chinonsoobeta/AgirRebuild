import type { CurrencyCode } from "@agir/numbers";

// The normalized document: what every parser produces and every finder reads.
// Every line and cell keeps the location it came from, so each extracted value
// can name its page and line, or its sheet and cell.

export type Line = { text: string; location: string };

/** What a cell's number format (or the unit word beside it) says the number is written in. */
export type CellUnit = "%" | "$" | "months" | "years" | "x" | "sf" | "m2";

export type Cell = {
  text: string;
  /** A spreadsheet cell that holds a number is read as that number, with no parsing. */
  number?: number;
  unit?: CellUnit;
  /** The currency the cell's number format names ("[$USD]", "US$"); absent for a plain or locale-only dollar. */
  currency?: CurrencyCode;
  ref: string;
};

/** `at`: how many of the document's lines come before the table, so a heading above it can be found (Word files). */
export type Table = { name: string; rows: Cell[][]; at?: number };

export type NormalizedDocument = {
  kind: "pdf" | "xlsx" | "csv" | "docx" | "txt";
  lines: Line[];
  tables: Table[];
  pageCount: number | null;
  /** True when a PDF had no text layer, so nothing could be read without OCR. */
  needsOcr: boolean;
  /** All readable text, for number-format detection. */
  fullText: string;
  /** What the parser could not read from the file as a whole ("formulas with no saved results"); shown with the document, never read as values. */
  notes?: string[];
};

export function columnName(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
