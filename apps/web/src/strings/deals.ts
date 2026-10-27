// Strings for the deals area. Keys start with "deals.".
import { register, type Entry, type FrenchOf } from "./entry";

const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

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

export const en = {
  "deals.lead": (p) => enLead(p as Counts),
  "deals.f.stale": "Out of date",
  "deals.tag.blocked": "Blocked",
  "deals.tag.decide": "Ready to decide",
  "deals.tag.progress": "In progress",
  "deals.tag.decided": "Decided",
  "deals.tag.stale": "Out of date",
  "deals.open": "Open the deal",
  "deals.decidedOn": (p) => `Decided on ${p.date} against run ${p.n}.`,
  "deals.changedAfter": (p) => `An input, a threshold or the engine changed after run ${p.n}.`,
  "deals.atStep": (p) => `At step ${p.n} of 5, ${p.step}`,
  "deals.welcome": (p) => (p.name ? `Welcome, ${p.name}. Let's start your first deal.` : "Welcome. Let's start your first deal."),
  "deals.welcomeLead": "A deal begins with a name and a place. After that you can upload what you have, or answer a few questions and add documents later. Nothing runs until the figures are approved.",
  "deals.newSub": "Name your project, then type your numbers or upload documents.",
  "deals.emptyViewer": "There are no deals you can see yet.",
  "deals.privacy": "How your data is handled",
  "deals.title": "Deals",
  "deals.search": "Search deals",
  "deals.new": "New deal",
  "deals.filter": "Filter deals",
  "deals.f.all": "All",
  "deals.f.blocked": "Blocked",
  "deals.f.decide": "Ready to decide",
  "deals.f.progress": "In progress",
  "deals.f.decided": "Decided",
  "deals.docs": (p) => `${p.n} ${s(p.n, "document", "documents")}`,
  "deals.noMatch": "No deals match.",
  "deals.evidence": "Where a deal stands comes from its evidence: the documents, the approved inputs, a current run, a recorded decision. Nobody sets it by hand.",
  "deals.name": "Name",
  "deals.location": "Location",
  "deals.country": "Country",
  "deals.country.CA": "Canada",
  "deals.country.US": "United States",
  "deals.province": "Province or territory",
  "deals.provinceChoose": "Choose one",
  "deals.currency": "Currency",
  "deals.currencyHint": "Every amount in this deal is in this currency. It is set now and cannot be changed later.",
  "deals.create": "Create deal",
} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {
  "deals.lead": (p) => frLead(p as Counts),
  "deals.f.stale": "Périmés",
  "deals.tag.blocked": "Bloqué",
  "deals.tag.decide": "Prêt pour décision",
  "deals.tag.progress": "En cours",
  "deals.tag.decided": "Décidé",
  "deals.tag.stale": "Périmé",
  "deals.open": "Ouvrir le projet",
  "deals.decidedOn": (p) => `Décidé le ${p.date}, d'après l'analyse ${p.n}.`,
  "deals.changedAfter": (p) => `Une donnée, un seuil ou le moteur a changé depuis l'analyse ${p.n}.`,
  "deals.atStep": (p) => `Étape ${p.n} sur 5, ${p.step}`,
  "deals.welcome": (p) => (p.name ? `Bienvenue, ${p.name}. Commençons votre premier projet.` : "Bienvenue. Commençons votre premier projet."),
  "deals.welcomeLead": "Un projet commence par un nom et un lieu. Ensuite, vous pouvez téléverser ce que vous avez, ou répondre à quelques questions et ajouter les documents plus tard. Rien n'est lancé avant que les chiffres soient approuvés.",
  "deals.newSub": "Nommez votre projet, puis saisissez vos chiffres ou téléversez des documents.",
  "deals.emptyViewer": "Il n'y a encore aucun projet que vous pouvez voir.",
  "deals.privacy": "Comment vos données sont traitées",
  "deals.title": "Projets",
  "deals.search": "Rechercher un projet",
  "deals.new": "Nouveau projet",
  "deals.filter": "Filtrer les projets",
  "deals.f.all": "Tous",
  "deals.f.blocked": "Bloqués",
  "deals.f.decide": "Prêts pour décision",
  "deals.f.progress": "En cours",
  "deals.f.decided": "Décidés",
  "deals.docs": (p) => `${p.n} ${s(p.n, "document", "documents")}`,
  "deals.noMatch": "Aucun projet ne correspond.",
  "deals.evidence": "L'état d'un projet découle de ses preuves\u00a0: les documents, les données approuvées, une analyse à jour, une décision consignée. Personne ne le fixe à la main.",
  "deals.name": "Nom",
  "deals.location": "Emplacement",
  "deals.country": "Pays",
  "deals.country.CA": "Canada",
  "deals.country.US": "États-Unis",
  "deals.province": "Province ou territoire",
  "deals.provinceChoose": "Choisissez-en une",
  "deals.currency": "Devise",
  "deals.currencyHint": "Tous les montants de ce projet sont dans cette devise. Elle est fixée maintenant et ne peut plus être modifiée.",
  "deals.create": "Créer le projet",
};

register(en, fr);
