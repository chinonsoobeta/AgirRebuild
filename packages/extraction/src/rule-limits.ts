import type { NormalizedDocument } from "./document.ts";

/**
 * What one document may ask of the rule pass. The pass holds the worker while it runs, and the job's lease cannot renew meanwhile,
 * so a strange file must not be able to run for long. Each limit counts what is in the file, never the clock: a file always reads the same.
 * Every limit sits above the largest of 1,124 real documents measured, whose most figures is 43,661. At 50,000 figures the slowest text measured takes about 130 s here.
 */
export const MAX_RULE_TEXT = 10_000; // Characters in one line, one cell, or one paragraph of wrapped lines.
export const MAX_RULE_FIGURES = 50_000; // Runs of digits in lines and typed cells.
export const MAX_RULE_CHARS = 3_000_000; // Characters in lines and typed cells.
export const MAX_RULE_WORK = 20_000_000; // Over all sentences, figures in a sentence times its length: each figure scans its sentence.
export const RULE_LIMIT_NOTE = "This file is too long for Agir's rules to read in full, so they may have missed figures further in.";

export const digitRuns = (text: string) => text.match(/\d+/g)?.length ?? 0;

/** The part of a document the rules read. The document itself, which the AI reading gets, is untouched. */
export function boundedForRules(doc: NormalizedDocument): { doc: NormalizedDocument; cut: boolean } {
  let figures = 0;
  let chars = 0;
  let cut = false;
  const spent = () => figures > MAX_RULE_FIGURES || chars > MAX_RULE_CHARS;
  const lines = doc.lines.flatMap((line) => {
    if (spent()) { cut = true; return []; }
    if (line.text.length > MAX_RULE_TEXT) { cut = true; return [{ text: "", location: line.location }]; }
    figures += digitRuns(line.text);
    chars += line.text.length;
    return [line];
  });
  const tables = doc.tables.map((table) => ({
    ...table,
    rows: table.rows.flatMap((row) => {
      if (spent()) { cut = true; return []; }
      return [row.map((cell) => {
        if (cell.computed) return cell;
        if (cell.text.length > MAX_RULE_TEXT) { cut = true; return { text: "", ref: cell.ref }; }
        figures += digitRuns(cell.text);
        chars += cell.text.length;
        return cell;
      })];
    }),
  }));
  return cut ? { doc: { ...doc, lines, tables, fullText: doc.fullText.slice(0, MAX_RULE_CHARS) }, cut } : { doc, cut };
}
