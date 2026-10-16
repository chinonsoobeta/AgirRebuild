export * from "./document.ts";
export { parseDocument, parseCsv, kindOf, UnsupportedDocumentError } from "./parse.ts";
export { extractCandidates, type Candidate, type ExtractionResult } from "./candidates.ts";
export { canonicalItem, itemFold, currencyOf, mapToken, normalizeLabel } from "./mapping.ts";
export { applyLabels, applySuggestions, consolidate, figureOrder, LABELLED_NOTE, offerable, offeredIds, SUGGESTED_NOTE, withoutLabelled, type Proposal, type SourcedCandidate } from "./consolidate.ts";
export { scoreExtraction, type GoldenEntry, type Score } from "./score.ts";
