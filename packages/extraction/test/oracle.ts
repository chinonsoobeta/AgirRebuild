import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Cell, NormalizedDocument } from "../src/index.ts";
import { columnName } from "../src/index.ts";

export type OracleDoc = { name: string; kind: "pdf" | "xlsx" | "csv" | "txt"; title?: string; sheet?: string; lines?: string[]; rows?: (string | number)[][] };
export type OracleDeal = {
  slug: string;
  name: string;
  assetType: string;
  location: string;
  purpose: string;
  documents: OracleDoc[];
  expect: {
    conflicts: { key: string; values: number[] }[];
    missing: string[];
    values?: Record<string, number>;
    neverValues?: Record<string, number[]>;
    neverInputs?: number[];
    teaserNeverCandidates?: string[];
    runs: boolean;
  };
};

const ORACLE_DIR = join(import.meta.dirname, "../../../oracles/deals");

export function loadOracles(): OracleDeal[] {
  return readdirSync(ORACLE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(ORACLE_DIR, f), "utf8")) as OracleDeal);
}

/** The document as a parser would produce it, without generating file bytes. */
export function toNormalized(doc: OracleDoc): NormalizedDocument {
  if (doc.rows) {
    const rows: Cell[][] = doc.rows.map((r, i) =>
      r.map((v, c) =>
        typeof v === "number"
          ? { text: String(v), number: v, unit: "$" as const, ref: `${doc.sheet ?? "Sheet1"}!${columnName(c)}${i + 1}` }
          : { text: v, ref: `${doc.sheet ?? "Sheet1"}!${columnName(c)}${i + 1}` },
      ),
    );
    return { kind: doc.kind === "csv" ? "csv" : "xlsx", lines: [], tables: [{ name: doc.sheet ?? "Sheet1", rows }], pageCount: null, needsOcr: false, fullText: doc.rows.map((r) => r.join(" ")).join("\n") };
  }
  const lines = [doc.title ?? "", ...(doc.lines ?? [])].filter(Boolean).map((text, i) => ({ text, location: `page 1, line ${i + 1}` }));
  return { kind: "pdf", lines, tables: [], pageCount: 1, needsOcr: false, fullText: lines.map((l) => l.text).join("\n") };
}
