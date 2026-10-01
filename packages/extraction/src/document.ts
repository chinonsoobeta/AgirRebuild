// The normalized document: what every parser produces and every finder reads.
// Every line and cell keeps the location it came from, so each extracted value
// can name its page and line, or its sheet and cell.

export type Line = { text: string; location: string };

export type Cell = {
  text: string;
  /** A spreadsheet cell that holds a number is read as that number, with no parsing. */
  number?: number;
  unit?: "%" | "$";
  ref: string;
};

export type Table = { name: string; rows: Cell[][] };

export type NormalizedDocument = {
  kind: "pdf" | "xlsx" | "csv" | "docx" | "txt";
  lines: Line[];
  tables: Table[];
  pageCount: number | null;
  /** True when a PDF had no text layer, so nothing could be read without OCR. */
  needsOcr: boolean;
  /** All readable text, for number-format detection. */
  fullText: string;
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
