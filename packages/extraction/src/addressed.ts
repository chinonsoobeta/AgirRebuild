import type { NormalizedDocument } from "./document.ts";

/** Keep every covered address available for quote verification. */
export function addressedEntries(doc: NormalizedDocument): { location: string; text: string }[] {
  const mark = (text: string, struck: [number, number][] = []) => {
    const ranges = [...struck].sort((a, b) => a[0] - b[0]);
    let out = "", end = 0;
    for (const [a, b] of ranges) {
      out += text.slice(end, a) + "~~" + text.slice(a, b) + "~~";
      end = b;
    }
    return out + text.slice(end);
  };
  return [
    ...doc.lines.filter(l => l.text.trim()).map(l => ({ location: l.location, text: mark(l.text, l.struck) })),
    ...doc.tables.flatMap(t => t.rows.flatMap(row => row.filter(c => c.text.trim()).map(c => ({ location: c.ref, text: mark(c.text, c.struck) })))),
  ];
}

export function addressedText(doc: NormalizedDocument, fileName: string): string {
  const entries = addressedEntries(doc);
  const runs: typeof entries = [];
  for (const entry of entries) {
    const previous = runs.at(-1);
    const cell = /^(.*!)([A-Z]+)(\d+)$/.exec(entry.location);
    const last = previous && /^(.*!)([A-Z]+)(\d+)(?:\.\.([A-Z]+)\d+)?$/.exec(previous.location);
    const column = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
    if (previous && cell && last && previous.text === entry.text && cell[1] === last[1] && cell[3] === last[3] && column(cell[2]!) === column(last[4] ?? last[2]!) + 1) {
      previous.location = `${last[1]}${last[2]}${last[3]}..${cell[2]}${cell[3]}`;
    } else runs.push({ ...entry });
  }
  return [`=== FILE ${fileName} ===`, ...runs.map(e => `[${e.location}] ${e.text}`)].join("\n");
}
