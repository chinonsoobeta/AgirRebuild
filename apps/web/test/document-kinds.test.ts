import { describe, expect, it } from "vitest";
import { FINGERPRINTS } from "../../../packages/extraction/src/document-kind.ts";
import { DOCUMENT_KINDS, parseReadRole } from "../src/documentKinds";
import { translateMessage } from "../src/i18n.tsx";

// Card 189: the table the screens use to say why a file was set aside.
describe("the table of document kinds", () => {
  const kinds = new Set(FINGERPRINTS.map(f => f.kind));
  it("has a label in both languages for every kind but the unrecognized one", () => {
    for (const kind of kinds) {
      if (kind === "unrecognized document") continue;
      expect(DOCUMENT_KINDS[kind]?.en, kind).toBeTruthy();
      expect(DOCUMENT_KINDS[kind]?.fr, kind).toBeTruthy();
    }
    expect(DOCUMENT_KINDS["unrecognized document"]).toBeUndefined();
  });
  it("has no kind that no fingerprint uses", () => {
    expect(Object.keys(DOCUMENT_KINDS).filter(kind => !kinds.has(kind))).toEqual([]);
  });
});

describe("parseReadRole", () => {
  it("reads what the worker stores", () => {
    expect(parseReadRole("market report (context)")).toEqual({ kind: "market report", role: "context", byPerson: false });
    expect(parseReadRole("market report (context, set by a person)")).toEqual({ kind: "market report", role: "context", byPerson: true });
    expect(parseReadRole("offering memorandum for one project (evidence)")).toEqual({ kind: "offering memorandum for one project", role: "evidence", byPerson: false });
    expect(parseReadRole("unrecognized document (deal source)")).toEqual({ kind: "unrecognized document", role: "deal source", byPerson: false });
  });
  it.each([null, undefined, "", "market report", "market report (other)", "(context)"])("returns null for %s", value => {
    expect(parseReadRole(value)).toBeNull();
  });
});

describe("the context note in French", () => {
  const tail = "ses chiffres sont affichés, mais pas lus. Aucun champ ne correspond à ce libellé";
  it.each([
    ["This document looks like a market report; its figures are shown, not read. No field matches this label", `Ce document ressemble à un rapport de marché ; ${tail}`],
    ["This document looks like an audit; its figures are shown, not read. No field matches this label", `Ce document ressemble à un rapport de vérification ; ${tail}`],
    ["This document looks like a audit; its figures are shown, not read. No field matches this label", `Ce document ressemble à un rapport de vérification ; ${tail}`],
    ["This document looks like an unrecognized document; its figures are shown, not read. No field matches this label", `Ce document sert de contexte ; ${tail}`],
    ["This document looks like a thing nobody listed; its figures are shown, not read. No field matches this label", `Ce document sert de contexte ; ${tail}`],
  ])("%s", (note, french) => {
    expect(translateMessage(note)).toBe(french);
  });
});

// Card 190: the two other notes on a figure, in French. Section text stays as the document writes it.
describe("the notes on a figure in French", () => {
  const shown = "ses chiffres sont affichés, mais pas lus";
  it.each([
    ["Read from a term sheet; check it", "Lu dans une lettre d'offre\u00a0; à vérifier"],
    ["Read from an appraisal; check it", "Lu dans une évaluation\u00a0; à vérifier"],
    ["Read from a appraisal; check it", "Lu dans une évaluation\u00a0; à vérifier"],
    ["Read from an unrecognized document; check it", "Lu dans un document\u00a0; à vérifier"],
    ["Read from a thing nobody listed; check it", "Lu dans un document\u00a0; à vérifier"],
    ["Read from an appraisal; check it. No field matches this label", "Lu dans une évaluation\u00a0; à vérifier. Aucun champ ne correspond à ce libellé"],
    ["Read from a thing nobody listed; check it. No field matches this label", "Lu dans un document\u00a0; à vérifier. Aucun champ ne correspond à ce libellé"],
    ["The risk factors section of a business plan; its figures are shown, not read", `La section «\u00a0risk factors\u00a0» d'un plan d'affaires\u00a0; ${shown}`],
    ["The risk factors section of an offering memorandum for one project; its figures are shown, not read", `La section «\u00a0risk factors\u00a0» d'une notice d'offre pour un seul projet\u00a0; ${shown}`],
    ["The bilan section of a thing nobody listed; its figures are shown, not read", `La section «\u00a0bilan\u00a0» d'un document\u00a0; ${shown}`],
  ])("%s", (note, french) => {
    expect(translateMessage(note)).toBe(french);
  });
});
