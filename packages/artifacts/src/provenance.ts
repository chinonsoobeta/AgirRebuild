import type { ProvenanceEntry } from "./format.ts";

export type ProvenanceReport = {
  pass: boolean;
  entries: number;
  orphans: string[];
};

/**
 * The backstop scan. Remove every recorded figure from the rendered text,
 * longest first; any digit left over was printed without a source and
 * blocks the artifact. Bare small ordinals (1 to 12, as in "Year 3") are the
 * only numbers allowed without an entry.
 */
export function verifyProvenance(renderedText: string, manifest: readonly ProvenanceEntry[]): ProvenanceReport {
  let text = renderedText.replace(/\s+/g, " ");
  const texts = [...new Set(manifest.map((e) => e.text.replace(/\s+/g, " ")))].sort((a, b) => b.length - a.length);
  for (const t of texts) {
    if (!/\d/.test(t)) continue;
    text = text.split(t).join(" ");
  }
  const orphans: string[] = [];
  for (const m of text.matchAll(/[$-]?\d[\d,.]*\s?(%|x\b|bps|SF)?/g)) {
    const raw = m[0].trim();
    const bare = /^\d{1,2}$/.test(raw) && Number(raw) >= 0 && Number(raw) <= 12;
    if (!bare) orphans.push(raw);
  }
  return { pass: orphans.length === 0, entries: manifest.length, orphans };
}
