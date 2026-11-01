import { addressedText } from "./addressed.ts";
import type { NormalizedDocument } from "./document.ts";

/** How much of a deal's workbooks one AI reading takes unasked: about 300,000 tokens, at the 0.51 to 0.63 tokens per character measured on workbooks. */
export const MAX_READING_CHARS = 500_000;
/** How much a person's "Read it anyway" may send: about 945,000 tokens at the highest rate measured, so the reading still fits the model's limit of 1,000,000. */
export const MAX_ASKED_READING_CHARS = 1_500_000;
/** Workbooks keep this much room, however long the deal's other files are. */
export const MIN_SHEET_ROOM = 200_000;

export type ReadingInput = { name: string; document: NormalizedDocument; asked: boolean };
export type ReadingText = { text: string; sheetsLeftOut: string[] };

/**
 * What the AI reader gets of each document. Everything but a workbook or a CSV goes whole. Those share what is left, whole sheets only, smallest first, because
 * the sheets that hold a deal's inputs are short and the long ones are schedules worked out from them. Sheets a person asked for come before the others. The
 * same files always give the same text, and a deal whose files all fit gets exactly their whole text.
 */
export function readingTexts(inputs: ReadingInput[]): ReadingText[] {
  const shared = ({ document }: ReadingInput) => document.kind === "xlsx" || document.kind === "csv";
  const fixed = inputs.reduce((n, input) => n + (shared(input) ? 0 : addressedText(input.document, input.name).length), 0);
  const sheets = inputs.filter(shared)
    .flatMap(input => input.document.tables.map(table => ({ asked: input.asked, table, size: addressedText({ ...input.document, lines: [], tables: [table] }, input.name).length })))
    .sort((a, b) => a.size - b.size);
  const kept = new Set<NormalizedDocument["tables"][number]>();
  const take = (asked: boolean, room: number) => {
    for (const sheet of sheets) {
      if (sheet.asked !== asked) continue;
      if (sheet.size > room) break;
      room -= sheet.size;
      kept.add(sheet.table);
    }
    return room;
  };
  const left = take(true, Math.max(MAX_ASKED_READING_CHARS - fixed, MIN_SHEET_ROOM));
  take(false, Math.min(left, Math.max(MAX_READING_CHARS - fixed, MIN_SHEET_ROOM)));
  return inputs.map(input => {
    if (!shared(input)) return { text: addressedText(input.document, input.name), sheetsLeftOut: [] };
    const tables = input.document.tables.filter(table => kept.has(table));
    return { text: addressedText({ ...input.document, tables }, input.name), sheetsLeftOut: input.document.tables.filter(table => !kept.has(table)).map(table => table.name) };
  });
}
