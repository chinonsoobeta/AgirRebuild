// Strings for the deals area. Keys start with "deals.".
import type { Entry, FrenchOf } from "./entry";

type Counts = { blocked: number; ready: number; progress: number; decided: number; solo: boolean };

const EN_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const FR_WORDS = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix"];
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

/** Pairs of clauses, each pair one sentence: "A and B. C and D." */
function sentences(clauses: string[], and: string): string {
  const out: string[] = [];
  for (let i = 0; i < clauses.length; i += 2) out.push(cap(clauses.slice(i, i + 2).join(and)) + ".");
  return out.join(" ");
}

function enLead(p: Counts): string {
  const w = (n: number) => EN_WORDS[n] ?? String(n);
  const be = (n: number) => (n === 1 ? "is" : "are");
  const ready = p.solo ? "ready for your decision" : "ready for a committee decision";
  const states: [number, string][] = [[p.blocked, "blocked"], [p.ready, ready], [p.progress, "in progress"], [p.decided, "decided"]];
  const present = states.filter(([n]) => n > 0);
  const total = present.reduce((a, [n]) => a + n, 0);
  if (present.length === 1) {
    const what = present[0]![1];
    return total === 1 ? `Your deal is ${what}.` : total === 2 ? `Both deals are ${what}.` : `All ${w(total)} deals are ${what}.`;
  }
  return sentences(present.map(([n, what], i) => `${w(n)}${i === 0 ? (n === 1 ? " deal" : " deals") : ""} ${be(n)} ${what}`), " and ");
}

function frLead(p: Counts): string {
  const w = (n: number) => FR_WORDS[n] ?? String(n);
  const pl = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const ready = (n: number) => `${pl(n, "prêt", "prêts")} pour ${p.solo ? "votre décision" : "une décision du comité"}`;
  const states: [number, (n: number) => string][] = [
    [p.blocked, (n) => pl(n, "bloqué", "bloqués")],
    [p.ready, ready],
    [p.progress, () => "en cours"],
    [p.decided, (n) => pl(n, "décidé", "décidés")],
  ];
  const present = states.filter(([n]) => n > 0);
  const total = present.reduce((a, [n]) => a + n, 0);
  if (present.length === 1) {
    const what = present[0]![1](total);
    return total === 1 ? `Votre projet est ${what}.` : total === 2 ? `Vos deux projets sont ${what}.` : `Vos ${w(total)} projets sont ${what}.`;
  }
  return sentences(present.map(([n, what], i) => `${w(n)}${i === 0 ? pl(n, " projet", " projets") : ""} ${pl(n, "est", "sont")} ${what(n)}`), " et ");
}

type Facts = { n: string; one: boolean; known: boolean; exit: "sale" | "refinance_hold" | "for_sale" | null };

/** The units and how the deal ends, as the deal heading says them; "" when neither is known. */
function enFacts({ n, one, known, exit }: Facts): string {
  const units = (kind: string) => `${n} ${kind}${one ? "unit" : "units"}`;
  if (!known) return exit === "refinance_hold" ? "kept and refinanced" : exit === "sale" ? "sold at the end of the hold" : exit === "for_sale" ? "for sale" : "";
  return exit === "refinance_hold" ? `${units("rental ")}, kept and refinanced` : exit === "sale" ? `${units("rental ")}, sold at the end of the hold`
    : exit === "for_sale" ? `${units("")} for sale` : units("");
}

function frFacts({ n, one, known, exit }: Facts): string {
  const pl = (single: string, many: string) => (one ? single : many);
  if (!known) return exit === "refinance_hold" ? "conservé et refinancé" : exit === "sale" ? "vendu à la fin de la détention" : exit === "for_sale" ? "à vendre" : "";
  const rental = `${n} ${pl("logement locatif", "logements locatifs")}`;
  return exit === "refinance_hold" ? `${rental}, ${pl("conservé et refinancé", "conservés et refinancés")}` : exit === "sale" ? `${rental}, ${pl("vendu", "vendus")} à la fin de la détention`
    : exit === "for_sale" ? `${n} ${pl("logement", "logements")} à vendre` : `${n} ${pl("logement", "logements")}`;
}

export const en = {
  "deals.facts": (p) => enFacts(p as Facts),
  "deals.amountsIn": (p) => `amounts in ${p.c}`,
  "deals.lead": (p) => enLead(p as Counts),
  "deals.f.stale": "Out of date",
  "deals.tag.blocked": "Blocked",
  "deals.tag.decide": "Ready to decide",
  "deals.tag.progress": "In progress",
  "deals.tag.decided": "Decided",
  "deals.tag.stale": "Out of date",
  "deals.decidedOn": (p) => `Decided on ${p.date} against run ${p.n}.`,
  "deals.changedAfter": (p) => `An input, a threshold or the engine changed after run ${p.n}.`,
  "deals.atStep": (p) => `At step ${p.n} of 5, ${p.step}`,
  "deals.welcome": (p) => (p.name ? `Welcome, ${p.name}. Let's start your first deal.` : "Welcome. Let's start your first deal."),
  "deals.welcomeLead": "A deal begins with a name and a place. After that you can upload what you have, or answer a few questions and add documents later. Nothing runs until the figures are approved.",
  "deals.way.docs": "Start from documents",
  "deals.way.docsBody": "A budget, a rent roll, a term sheet, an appraisal. Agir reads them, shows you each figure with the line it came from, and asks you to approve.",
  "deals.way.qs": "Answer a few questions",
  "deals.way.qsBody": "A few plain questions for a small rental or a for-sale project, each answer recorded with where it came from. You name the deal first, and the questions wait on its Documents step.",
  "deals.way.qsGo": "Quick start",
  "deals.emptyViewer": "There are no deals you can see yet.",
  "deals.privacy": "How your data is handled",
} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {
  "deals.facts": (p) => frFacts(p as Facts),
  "deals.amountsIn": (p) => `montants en ${p.c}`,
  "deals.lead": (p) => frLead(p as Counts),
  "deals.f.stale": "Périmés",
  "deals.tag.blocked": "Bloqué",
  "deals.tag.decide": "Prêt pour décision",
  "deals.tag.progress": "En cours",
  "deals.tag.decided": "Décidé",
  "deals.tag.stale": "Périmé",
  "deals.decidedOn": (p) => `Décidé le ${p.date}, d'après l'analyse ${p.n}.`,
  "deals.changedAfter": (p) => `Une donnée, un seuil ou le moteur a changé depuis l'analyse ${p.n}.`,
  "deals.atStep": (p) => `Étape ${p.n} sur 5, ${p.step}`,
  "deals.welcome": (p) => (p.name ? `Bienvenue, ${p.name}. Commençons votre premier projet.` : "Bienvenue. Commençons votre premier projet."),
  "deals.welcomeLead": "Un projet commence par un nom et un lieu. Ensuite, vous pouvez téléverser ce que vous avez, ou répondre à quelques questions et ajouter les documents plus tard. Rien n'est lancé avant que les chiffres soient approuvés.",
  "deals.way.docs": "Partir des documents",
  "deals.way.docsBody": "Un budget, un état des loyers, une lettre d'offre, une évaluation. Agir les lit, vous montre chaque chiffre avec la ligne d'où il vient et vous demande de l'approuver.",
  "deals.way.qs": "Répondre à quelques questions",
  "deals.way.qsBody": "Quelques questions simples pour un petit immeuble locatif ou un projet à vendre, chaque réponse étant consignée avec sa provenance. Vous nommez d'abord le projet, puis les questions vous attendent à son étape Documents.",
  "deals.way.qsGo": "Démarrage rapide",
  "deals.emptyViewer": "Il n'y a encore aucun projet que vous pouvez voir.",
  "deals.privacy": "Comment vos données sont traitées",
};
