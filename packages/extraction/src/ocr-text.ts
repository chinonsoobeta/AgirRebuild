import type { Line, NormalizedDocument } from "./document.ts";

export const MAX_OCR_PAGES = 50;
export const isOcrLocation = (location: string): boolean => / \(OCR, confidence \d+%\)$/.test(location);

// Set from 337 picture pages of real documents on 2026-10-31: maps and photos
// give garbage lines under 60 on low-confidence pages; real text has lines down to about 40.
export const keepOcrLine = (confidence: number, pageConfidence: number): boolean => confidence >= 60 || (confidence >= 40 && pageConfidence >= 65);

export type OcrPage = { page: number; lines: { text: string; confidence: number }[] };
export type SavedOcr = { version: 1; pages: OcrPage[]; failed: number[]; notRead: number[] };
export const serializeOcr = (saved: SavedOcr): Uint8Array => new TextEncoder().encode(JSON.stringify(saved));
export function parseSavedOcr(bytes: Uint8Array | null): SavedOcr | null {
  if (!bytes) return null;
  try {
    const saved = JSON.parse(new TextDecoder().decode(bytes));
    if (saved?.version !== 1 || !Array.isArray(saved.pages) || !Array.isArray(saved.failed) || !Array.isArray(saved.notRead)) return null;
    if (!saved.pages.every((p: OcrPage) => Number.isInteger(p?.page) && p.page > 0 && Array.isArray(p.lines) && p.lines.every(l => typeof l?.text === "string" && Number.isFinite(l.confidence)))) return null;
    if (![...saved.failed, ...saved.notRead].every(n => Number.isInteger(n) && n > 0)) return null;
    return saved;
  } catch { return null; }
}

/** Stable addresses use the raw OCR position, even for lines later filtered out. */
export function mergeOcr(doc: NormalizedDocument, saved: SavedOcr): NormalizedDocument {
  const pages = new Map<number, Line[]>();
  for (const line of doc.lines) {
    const page = Number(/^page (\d+), line \d+/.exec(line.location)?.[1]);
    const lines = pages.get(page) ?? [];
    lines.push(line); pages.set(page, lines);
  }
  for (const page of saved.pages) {
    const textLines = pages.get(page.page) ?? [];
    const last = Math.max(0, ...textLines.map(l => Number(/, line (\d+)/.exec(l.location)?.[1] ?? 0)));
    const words = textLines.map(l => l.text).join(" ").toLowerCase().trim().split(/\s+/);
    const length = page.lines.reduce((n, l) => n + l.text.length, 0);
    const confidence = length ? page.lines.reduce((n, l) => n + l.confidence * l.text.length, 0) / length : 0;
    const ocrLines = page.lines.flatMap((line, i) => {
      if (!line.text.trim() || !keepOcrLine(line.confidence, confidence)) return [];
      const own = line.text.toLowerCase().trim().split(/\s+/);
      if (words.some((_, start) => own.every((word, j) => words[start + j] === word))) return [];
      return [{ text: line.text, location: `page ${page.page}, line ${last + i + 1} (OCR, confidence ${Math.round(line.confidence)}%)` }];
    });
    pages.set(page.page, [...textLines, ...ocrLines]);
  }
  const lines = [...pages.entries()].sort(([a], [b]) => a - b).flatMap(([, lines]) => lines);
  return { ...doc, lines, fullText: lines.map(l => l.text).join("\n") };
}
