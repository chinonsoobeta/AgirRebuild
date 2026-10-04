export * from "./document.ts";
export { parseDocument, parseCsv, kindOf, UnsupportedDocumentError } from "./parse.ts";
export { extractCandidates, type Candidate, type ExtractionResult } from "./candidates.ts";
export { currencyOf, mapToken, normalizeLabel } from "./mapping.ts";
export { consolidate, type Proposal, type SourcedCandidate } from "./consolidate.ts";
export { scoreExtraction, type GoldenEntry, type Score } from "./score.ts";
