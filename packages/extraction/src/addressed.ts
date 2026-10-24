import type { NormalizedDocument } from "./document.ts";

/** The same addressed text is used for the request and for quote verification. */
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
  return [`=== FILE ${fileName} ===`, ...addressedEntries(doc).map(e => `[${e.location}] ${e.text}`)].join("\n");
}
