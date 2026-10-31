import { PREMIUM_TAX_HELP_FR } from "@agir/contracts";
// English and French (Canada). The shared interface strings and translated API messages live here; a string only
// one group of screens uses lives in strings/<area>.ts and loads with those screens.
// Shared field, metric, stress and gate labels live in @agir/contracts, together
// with number formats and structured report messages. Numbers follow the language:
// 51,962,556 and 6.45% in English, 51 962 556 $ and 6,45 % in French.

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { loaded, register, type Entry, type FrenchOf } from "./strings/entry";
// The shell's strings load with this module. Every other strings/<area>.ts loads with the screens that import it, which
// puts it in their route group (vite.config.ts); here they are imported for their types only.
import * as shellStrings from "./strings/shell";
import * as thresholdsStrings from "./strings/thresholds";
import * as termsStrings from "./strings/terms";
import type * as dealsStrings from "./strings/deals";
import type * as newdealStrings from "./strings/newdeal";
import type * as quickstartStrings from "./strings/quickstart";
import type * as documentsStrings from "./strings/documents";
import type * as reviewStrings from "./strings/review";
import type * as runStrings from "./strings/run";
import type * as decisionStrings from "./strings/decision";
import type * as reportsStrings from "./strings/reports";
import type * as exploreStrings from "./strings/explore";
import type * as auditStrings from "./strings/audit";
import type * as compareStrings from "./strings/compare";
import type * as settingsStrings from "./strings/settings";
import type * as authStrings from "./strings/auth";
import type * as landingStrings from "./strings/landing";
import type * as agirreviewStrings from "./strings/agirreview";
import type * as shareStrings from "./strings/share";
import { termsStore, useTerms, type TermsPref } from "./terms";
import { FR_VERIFY, FR_ABSENT, FR_FIELDS, FR_METRICS, STRESS, GATES, plainTerm, plainStress, numberFormat, verdictText as sharedVerdictText, checkText as sharedCheckText, type VerdictLike, type CheckLike, CURRENCY_NAMES, FIELDS, FIELD_BY_KEY, METRIC_BY_KEY, placeLabel, type Currency, type ReadinessItem } from "@agir/contracts";

export type Lang = "en" | "fr";

// ---- Interface strings -------------------------------------------------------------------
const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

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

// The strings the shell, the shared components or more than one group of screens use. A string only one group uses
// lives in that group's strings/<area>.ts.
const SHARED_EN = {
  "threshold.invalid": "These saved values no longer fit the policy, which changed after they were set. Runs are refused until each is changed or cleared.",
  "threshold.layerDeal": "deal", "threshold.layerWorkspace": "workspace",
  "threshold.title": "Thresholds", "threshold.strategy": "Strategy", "threshold.name": "Threshold", "threshold.standard": "Agir standard",
  "threshold.workspace": "Workspace value", "threshold.yours": "Your value", "threshold.looser": "Looser than Agir's standard",
  "threshold.cited": "Looser than CMHC's cited rule", "threshold.removed": "Stress removed", "threshold.reason": "Reason (required)",
  "threshold.save": "Save threshold", "threshold.clear": "Use inherited value", "threshold.whole": "whole numbers",
  "threshold.range": (p: any) => `${p.min}–${p.max} ${p.unit}${p.whole ? `; ${p.whole}` : ""}`,
  "threshold.standardVerdict": (p: any) => `Under Agir's standard thresholds: ${p.verdict}`,

  "reports.frDraft": "French, draft translation",
  "nav.deals": "Deals",
  "nav.settings": "Settings",
  "nav.signOut": "Sign out",
  "nav.language": "Français",
  "common.loading": "Loading…",
  "form.count": (p) => `${p.n} / ${p.max}`,
  "form.atLimit": (p) => `${p.max} characters: that is the limit, anything longer is cut.`,
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.download": "Download",
  "common.open": "Open",
  "common.notMeaningful": "Not meaningful",
  "common.notApplicable": "Not applicable",
  "common.workspace": "Workspace",
  "common.run": (p) => `Run ${p.n}`,

  "deals.currencyNone": "Currency not stated",

  "step.documents": "Documents",
  "step.review": "Review",
  "step.run": "Run",
  "step.decision": "Decision",
  "step.reports": "Reports",
  "step.steps": "Deal steps",
  "step.audit": "Audit trail",
  "copy.button": "Copy as a variant",
  "copy.title": "Copy as a variant",
  "copy.intro": "A variant is a copy of this deal in exactly its state: the same documents, values and approvals. Change it and run it to compare a scheme. Runs, decisions and reports stay with this deal.",
  "copy.name": "Name of the variant",
  "copy.suffix": ", variant",
  "copy.create": "Copy and open",
  "copy.variantOf": "Variant of",
  "step.noDocs": "No documents",
  "step.reading": (p) => `Reading ${p.n}`,
  "step.read": (p) => [p.n ? `${p.n} read` : "", p.failed ? `${p.failed} failed` : ""].filter(Boolean).join(", "),
  "step.waitingDocs": "Waiting for documents",
  "step.clear": "Clear",
  "step.readyToRun": "Ready to run",
  "step.locked": "Locked until review is clear",
  "step.runState": (p) => `Run ${p.n} · ${p.state}`,
  "step.outOfDate": "out of date",
  "step.notRecorded": "Not recorded",
  "step.waiting": "Waiting",
  "step.ready": (p) => `${p.n} ready`,
  "step.noneYet": "None yet",

  "status.noDocs": "No documents yet",
  "status.reading": (p) => `Reading ${p.n} ${s(p.n, "document", "documents")}`,
  "status.blocked": "Blocked",
  "status.needsYou": "Needs you",
  "status.conflicts": (p) => `${p.n} ${s(p.n, "conflict", "conflicts")}`,
  "status.missing": (p) => `${p.n} missing`,
  "status.toReview": (p) => `${p.n} to review`,
  "status.awaiting": (p) => `${p.n} awaiting a second approver`,
  "status.outOfRange": (p) => `${p.n} to correct`,
  "status.outOfDate": "Results are out of date",
  "status.readyToRun": "Ready to run",
  "status.verdict": (p) => `Verdict: ${p.v}`,
  "status.decided": (p) => `Decided: ${p.d}`,
  "next.upload": "Upload the deal documents",
  "next.retry": (p) => `Retry ${p.n} failed ${s(p.n, "document", "documents")}`,
  "next.wait": "Nothing to do yet",
  "next.resolve": (p) => `Resolve ${p.n} ${s(p.n, "conflict", "conflicts")}`,
  "next.enter": (p) => `Enter ${p.n} missing ${s(p.n, "input", "inputs")}`,
  "next.review": "Review the extracted values",
  "next.run": "Run underwriting",
  "next.runAgain": "Run underwriting again",
  "next.decide": "Record the decision",
  "next.decideSolo": "Record your decision",
  "next.share": "Share the reports",
  "next.memo": "Generate the reports",

  "review.useOutsideWindow": "Use this value",
  "auth.reviewMode": "How are values reviewed?",
  "review.revenueProgram": "Revenue program (at least one unit type or space)",

  "glossary.title": "What these terms mean",
  "glossary.dcr": () => ["DCR (debt coverage ratio), called DSCR by many lenders", "Net operating income divided by the full amortizing loan payment, even during an interest-only period, for the weakest year of the hold."],
  "glossary.noi": () => ["Net operating income (NOI)", "The rent and other income actually collected, less operating costs, before any loan payments."],
  "glossary.capRate": () => ["Cap rate (exit)", "The yield a buyer is assumed to require at sale; the final year's NOI divided by it gives the sale value."],
  "glossary.yieldOnCost": () => ["Yield on cost", "Stabilized NOI divided by the total cost of developing the project."],
  "glossary.loanToCost": () => ["Loan to cost (LTC)", "The share of the total development cost that is financed by loans."],
  "glossary.equityIrr": () => ["Equity IRR", "The annual rate of return on the equity put in, taking into account when each payment in and out happens."],
  "glossary.equityMultiple": () => ["Equity multiple", "All the cash paid back to equity divided by all the equity put in; 2.0x means twice what was invested."],
  "glossary.breakEven": () => ["Break-even occupancy", "The share of the potential rent that must be collected in year 1 to cover fixed operating costs, variable costs and loan payments."],

  "reports.memo": "Committee memo",
  "reports.lender": "Lender package",
  "reports.buildDecision": "Build decision",
  "reports.partnerMemo": "Partner memo",
  "reports.modelExport": "Model export",
  "reports.word": "Word",
  "reports.excel": "Excel",
  "reports.col.status": "Status",
  "share.copy": "Copy",
  "share.once": "Copy this link now. It is not shown again.",
  "share.by": "Made by",
  "share.on": "Made on",
  "share.expires": "Expires",
  "share.revoke": "Revoke",
  "share.expiry": (p) => /* the date ends in "a.m." or "p.m." */ `This link expires on ${p.date}`,
  "share.noExpiry": "This link does not expire.",
  "share.package": "Download the audit package",
  "share.readOnly": "Shared from Agir. Read-only.",

  "settings.mode.team": "Team review",
  "settings.mode.solo": "Solo review",
  "auth.verify.againSent": "We sent a new link and code. Earlier ones no longer work.",
  "auth.verify.newLink": "Send a new link",
  "auth.reset.send": "Send me a link",
  "auth.noMail": "No email could be sent: this server has no mail provider yet. Ask the person who runs it.",
  "compare.action": "Compare runs",
  "deals.facts": (p) => enFacts(p as Facts),
  "deals.amountsIn": (p) => `amounts in ${p.c}`,
  "explore.action": "Explore changes",
  "reports.tracedN": (p) => (p.n === 1 ? "1 figure traced" : `${p.n} figures traced`),
  "run.gateNeeds": (p) => `The gate needs ${p.v}`,
  "run.sub.perUnit": (p) => `${p.v} a unit`,
  "run.sub.loanToCost": (p) => `Loan to cost ${p.v}`,
  "settings.eyes.title": "Want a second pair of eyes?",
  "settings.eyes.body": "You can give a reviewer from outside this workspace time-limited access to confirm the values you stated.",
  "settings.eyes.link": "Give a reviewer access",
} satisfies Record<string, Entry>;

const SHARED_FR: FrenchOf<typeof SHARED_EN> = {
  "threshold.invalid": "Ces valeurs enregistrées ne correspondent plus à la politique, modifiée depuis. Les analyses sont refusées tant que chacune n'est pas modifiée ou effacée.",
  "threshold.layerDeal": "projet", "threshold.layerWorkspace": "espace de travail",
  "threshold.title": "Seuils", "threshold.strategy": "Stratégie", "threshold.name": "Seuil", "threshold.standard": "Standard d'Agir",
  "threshold.workspace": "Valeur de l'espace de travail", "threshold.yours": "Votre valeur", "threshold.looser": "Plus souple que le standard d'Agir",
  "threshold.cited": "Plus souple que la règle citée de la SCHL", "threshold.removed": "Stress retiré", "threshold.reason": "Motif (obligatoire)",
  "threshold.save": "Enregistrer le seuil", "threshold.clear": "Utiliser la valeur héritée", "threshold.whole": "nombres entiers",
  "threshold.range": (p: any) => `${p.min}–${p.max}\u00a0${({bps:"pb",years:"ans",months:"mois",units:"logements",gates:"critères"} as Record<string,string>)[p.unit] ?? p.unit}${p.whole ? `; ${p.whole}` : ""}`,
  "threshold.standardVerdict": (p: any) => `Selon les seuils standard d'Agir\u00a0: ${p.verdict}`,

  "reports.frDraft": "Français, traduction provisoire",
  "nav.deals": "Projets",
  "nav.settings": "Paramètres",
  "nav.signOut": "Se déconnecter",
  "nav.language": "English",
  "common.loading": "Chargement…",
  "form.count": (p) => `${p.n} / ${p.max}`,
  "form.atLimit": (p) => `${p.max} caractères\u00a0: c'est la limite, le reste est coupé.`,
  "common.cancel": "Annuler",
  "common.save": "Enregistrer",
  "common.download": "Télécharger",
  "common.open": "Ouvrir",
  "common.notMeaningful": "Non significatif",
  "common.notApplicable": "Sans objet",
  "common.workspace": "Espace de travail",
  "common.run": (p) => `Analyse ${p.n}`,

  "deals.currencyNone": "Devise non indiquée",

  "step.documents": "Documents",
  "step.review": "Examen",
  "step.run": "Analyse",
  "step.decision": "Décision",
  "step.reports": "Rapports",
  "step.steps": "Étapes du projet",
  "step.audit": "Piste d'audit",
  "copy.button": "Copier comme variante",
  "copy.title": "Copier comme variante",
  "copy.intro": "Une variante est une copie de ce projet dans exactement son état\u00a0: les mêmes documents, valeurs et approbations. Modifiez-la et lancez une analyse pour comparer un scénario. Les analyses, décisions et rapports restent avec ce projet.",
  "copy.name": "Nom de la variante",
  "copy.suffix": ", variante",
  "copy.create": "Copier et ouvrir",
  "copy.variantOf": "Variante de",
  "step.noDocs": "Aucun document",
  "step.reading": (p) => `Lecture de ${p.n}`,
  "step.read": (p) => [p.n ? `${p.n} ${s(p.n, "lu", "lus")}` : "", p.failed ? `${p.failed} en échec` : ""].filter(Boolean).join(", "),
  "step.waitingDocs": "En attente des documents",
  "step.clear": "Terminé",
  "step.readyToRun": "Prêt à lancer",
  "step.locked": "Bloqué jusqu'à la fin de l'examen",
  "step.runState": (p) => `Analyse ${p.n} · ${p.state}`,
  "step.outOfDate": "périmée",
  "step.notRecorded": "Non consignée",
  "step.waiting": "En attente",
  "step.ready": (p) => `${p.n} ${s(p.n, "prêt", "prêts")}`,
  "step.noneYet": "Aucun pour l'instant",

  "status.noDocs": "Aucun document pour l'instant",
  "status.reading": (p) => `Lecture de ${p.n} ${s(p.n, "document", "documents")}`,
  "status.blocked": "Bloqué",
  "status.needsYou": "Action requise",
  "status.conflicts": (p) => `${p.n} ${s(p.n, "conflit", "conflits")}`,
  "status.missing": (p) => `${p.n} ${s(p.n, "manquante", "manquantes")}`,
  "status.toReview": (p) => `${p.n} à examiner`,
  "status.awaiting": (p) => `${p.n} en attente d'un second approbateur`,
  "status.outOfRange": (p) => `${p.n} à corriger`,
  "status.outOfDate": "Les résultats sont périmés",
  "status.readyToRun": "Prêt à lancer",
  "status.verdict": (p) => `Verdict\u00a0: ${p.v}`,
  "status.decided": (p) => `Décidé\u00a0: ${p.d}`,
  "next.upload": "Téléverser les documents du projet",
  "next.retry": (p) => `Relancer ${p.n} ${s(p.n, "document en échec", "documents en échec")}`,
  "next.wait": "Rien à faire pour l'instant",
  "next.resolve": (p) => `Résoudre ${p.n} ${s(p.n, "conflit", "conflits")}`,
  "next.enter": (p) => `Saisir ${p.n} ${s(p.n, "donnée manquante", "données manquantes")}`,
  "next.review": "Examiner les valeurs extraites",
  "next.run": "Lancer l'analyse",
  "next.runAgain": "Relancer l'analyse",
  "next.decide": "Consigner la décision",
  "next.decideSolo": "Consigner votre décision",
  "next.share": "Partager les rapports",
  "next.memo": "Générer les rapports",

  "review.useOutsideWindow": "Utiliser cette valeur",
  "auth.reviewMode": "Comment les valeurs sont-elles examinées\u00a0?",
  "review.revenueProgram": "Programme de revenus (au moins un type de logement ou d'espace)",

  "glossary.title": "Ce que ces termes veulent dire",
  "glossary.dcr": () => ["CCD (coefficient de couverture de la dette), appelé RCSD par de nombreux prêteurs", "Le revenu net d'exploitation divisé par le paiement complet d'un prêt amorti, même pendant une période d'intérêts seulement, pour l'année la plus faible de la détention."],
  "glossary.noi": () => ["Revenu net d'exploitation (RNE)", "Les loyers et autres revenus réellement encaissés, moins les charges d'exploitation, avant tout paiement de prêt."],
  "glossary.capRate": () => ["Taux de capitalisation (sortie)", "Le rendement qu'un acheteur est supposé exiger à la vente\u00a0; le RNE de la dernière année divisé par ce taux donne la valeur de vente."],
  "glossary.yieldOnCost": () => ["Rendement sur coût", "Le RNE stabilisé divisé par le coût total de développement du projet."],
  "glossary.loanToCost": () => ["Ratio prêt-coût", "La part du coût total de développement qui est financée par des prêts."],
  "glossary.equityIrr": () => ["TRI des fonds propres", "Le taux de rendement annuel des fonds propres investis, selon le moment de chaque versement et de chaque distribution."],
  "glossary.equityMultiple": () => ["Multiple des fonds propres", "Tout l'argent rendu aux fonds propres divisé par tous les fonds propres investis\u00a0; 2,0x veut dire le double de la mise."],
  "glossary.breakEven": () => ["Occupation au seuil de rentabilité", "La part des loyers potentiels qui doit être encaissée à l'année 1 pour couvrir les charges fixes, les charges variables et les paiements de prêt."],

  "reports.memo": "Mémo du comité",
  "reports.lender": "Dossier pour le prêteur",
  "reports.buildDecision": "Décision de construire",
  "reports.partnerMemo": "Note aux partenaires",
  "reports.modelExport": "Export du modèle",
  "reports.word": "Word",
  "reports.excel": "Excel",
  "reports.col.status": "Statut",
  "share.copy": "Copier",
  "share.once": "Copiez ce lien maintenant. Il ne sera plus affiché.",
  "share.by": "Créé par",
  "share.on": "Créé le",
  "share.expires": "Expiration",
  "share.revoke": "Révoquer",
  "share.expiry": (p) => `Ce lien expire le ${p.date}.`,
  "share.noExpiry": "Ce lien n'expire pas.",
  "share.package": "Télécharger le dossier d'audit",
  "share.readOnly": "Partagé depuis Agir. Lecture seule.",

  "settings.mode.team": "Examen en équipe",
  "settings.mode.solo": "Examen individuel",

  "auth.verify.againSent": "Nous avons envoyé un nouveau lien et un nouveau code. Les précédents ne fonctionnent plus.",
  "auth.verify.newLink": "Envoyer un nouveau lien",
  "auth.reset.send": "M'envoyer un lien",
  "auth.noMail": "Aucun courriel n'a pu être envoyé\u00a0: ce serveur n'a pas encore de fournisseur de courriel. Demandez à la personne qui l'administre.",
  "compare.action": "Comparer des analyses",
  "deals.facts": (p) => frFacts(p as Facts),
  "deals.amountsIn": (p) => `montants en ${p.c}`,
  "explore.action": "Explorer des changements",
  "reports.tracedN": (p) => (p.n === 1 ? "1 chiffre retracé" : `${p.n} chiffres retracés`),
  "run.gateNeeds": (p) => `Le seuil exige ${p.v}`,
  "run.sub.perUnit": (p) => `${p.v} par logement`,
  "run.sub.loanToCost": (p) => `Ratio prêt-coût de ${p.v}`,
  "settings.eyes.title": "Un second regard\u00a0?",
  "settings.eyes.body": "Vous pouvez donner à un réviseur extérieur à cet espace un accès limité dans le temps pour confirmer les valeurs que vous avez déclarées.",
  "settings.eyes.link": "Donner accès à un réviseur",
};

// Every table, for the types: a key is any table's key, and no key may be defined in two tables.
type Tables = [
  typeof SHARED_EN, typeof shellStrings.en, typeof dealsStrings.en, typeof newdealStrings.en, typeof quickstartStrings.en,
  typeof documentsStrings.en, typeof reviewStrings.en, typeof runStrings.en, typeof decisionStrings.en, typeof reportsStrings.en,
  typeof exploreStrings.en, typeof auditStrings.en, typeof compareStrings.en, typeof settingsStrings.en, typeof authStrings.en,
  typeof landingStrings.en, typeof agirreviewStrings.en, typeof shareStrings.en, typeof thresholdsStrings.en, typeof termsStrings.en,
];
type KeysOf<U> = U extends unknown ? keyof U : never;
export type Key = KeysOf<Tables[number]>;
/** The keys found in more than one table. */
type Twice<T extends unknown[], Seen = never> = T extends [infer H, ...infer R] ? (keyof H & Seen) | Twice<R, Seen | keyof H> : never;
type MustBeNone<T extends never> = T;
/** A key defined twice is a type error here, naming the key. */
export type NoKeyDefinedTwice = MustBeNone<Twice<Tables>>;

register(SHARED_EN, SHARED_FR);
/** Every string loaded so far, by language: the shared ones, then each area's as the first screen that uses it loads. */
export const EN = loaded.en as Record<Key, Entry>;
export const FR = loaded.fr as Record<Key, Entry>;

// ---- Catalog labels in French ------------------------------------------------------------

const FR_HELP: Record<string, string> = {
  refinance_premium_tax_pct: PREMIUM_TAX_HELP_FR,
  unit_sale_price: "Net de TPS/TVH et de tout remboursement conservé par le constructeur.",
  contingency: "Saisissez 0 si le budget n'en prévoit pas.",
  other_cost: "Saisissez un vrai crédit (remise, remboursement) sous forme de montant négatif, avec le motif.",
  lease_up_months: "Saisissez 0 si l'actif est stabilisé dès la fin des travaux.",
  expense_ratio_pct: "Part du RBE de l'année 1, maintenue en dollars fixes et indexée selon la croissance des charges.",
  senior_loan_amount: "Saisissez 0 pour un projet financé entièrement par fonds propres.",
  development_charges: "Si vos coûts indirects ou autres coûts les incluent déjà, ne les saisissez pas.",
  land_transfer_tax: "Si vos coûts indirects ou autres coûts les incluent déjà, ne les saisissez pas.",
  gst_hst_net: "Si vos coûts indirects ou autres coûts l'incluent déjà, ne la saisissez pas.",
  property_tax_annual: "Ne la saisissez pas si votre ratio des charges ou vos charges d'exploitation fixes l'incluent déjà.",
  refinance_insurance_premium_pct: "La prime est ajoutée au prêt de refinancement. Ne la saisissez pas s'il n'y a pas d'assurance hypothécaire.",
};

// Quick-start questions: [question, hint] in English and in French, by field key.
const ASK: Record<string, [[string, string?], [string, string?]]> = {
  sell_units: [["Will you sell the units instead of renting them?"], ["Vendrez-vous les logements au lieu de les louer\u00a0?"]],
  unit_sale_price: [["What is the sale price per unit?", "Net of GST/HST and any rebate the builder keeps."], ["Quel est le prix de vente par logement\u00a0?", "Net de TPS/TVH et de tout remboursement conservé par le constructeur."]],
  presold_units_pct: [["What percentage of units is presold?", "Enter 0 if none are presold."], ["Quel pourcentage des logements est prévendu\u00a0?", "Saisissez 0 si aucun n'est prévendu."]],
  deposit_pct: [["What percentage of the price is the buyer's deposit?", "Enter 0 if there is no deposit. Deposits stay in trust and do not fund costs."], ["Quel pourcentage du prix représente le dépôt de l'acheteur\u00a0?", "Saisissez 0 s'il n'y a pas de dépôt. Les dépôts restent en fiducie et ne financent pas les coûts."]],
  absorption_units_per_month: [["How many units will sell per month?", "A fraction is allowed, such as 0.5 for one unit every two months."], ["Combien de logements seront vendus par mois\u00a0?", "Une fraction est permise, comme 0,5 pour un logement tous les deux mois."]],
  sales_commission_pct: [["What percentage of sales pays the commission?", "Enter 0 if there is no commission."], ["Quel pourcentage des ventes paie la commission\u00a0?", "Saisissez 0 s'il n'y a pas de commission."]],
  closing_lag_months: [["How many months from completion to the first closing?", "Enter 0 for a freehold townhome that closes at completion."], ["Combien de mois entre l'achèvement et la première conclusion de vente\u00a0?", "Saisissez 0 pour une maison en rangée en pleine propriété dont la vente est conclue à l'achèvement."]],
  unsold_carry_monthly: [["What will each unsold unit cost to carry per month?", "Enter 0 if there are no carrying costs."], ["Quels seront les frais de possession mensuels par logement non vendu\u00a0?", "Saisissez 0 s'il n'y a pas de frais de possession."]],
  senior_presale_threshold_pct: [["What percentage of units must be presold for the loan?", "Leave blank if no presale condition is stated."], ["Quel pourcentage des logements doit être prévendu pour le prêt\u00a0?", "Laissez vide si aucune condition de préventes n'est déclarée."]],
  land_cost: [["What did you pay, or will you pay, for the land?", "Include the purchase price only; closing costs go in soft costs."], ["Combien avez-vous payé, ou paierez-vous, pour le terrain\u00a0?", "Le prix d'achat seulement\u00a0; les frais de clôture vont dans les coûts indirects."]],
  hard_cost: [["What will construction cost?", "Labour and materials, from your builder's quote or estimate."], ["Combien coûteront les travaux de construction\u00a0?", "Main-d'œuvre et matériaux, selon la soumission ou l'estimation de l'entrepreneur."]],
  soft_cost: [["What will design, permits, fees and legal cost?", "Everything that is not land or construction."], ["Combien coûteront la conception, les permis, les frais et les services juridiques\u00a0?", "Tout ce qui n'est ni le terrain ni la construction."]],
  contingency: [["How much have you set aside for cost overruns?", "Enter 0 if you have set nothing aside."], ["Quelle somme avez-vous prévue pour les dépassements de coûts\u00a0?", "Saisissez 0 si vous n'avez rien prévu."]],
  other_cost: [["Any other project costs?", "Leave blank if there are none."], ["D'autres coûts de projet\u00a0?", "Laissez vide s'il n'y en a pas."]],
  construction_months: [["How many months will construction take?", "Enter 0 if the building is already built."], ["Combien de mois dureront les travaux\u00a0?", "Saisissez 0 si l'immeuble est déjà construit."]],
  lease_up_months: [["How many months to fill the building after it is finished?", "Enter 0 if it is rented from day one."], ["Combien de mois pour remplir l'immeuble une fois terminé\u00a0?", "Saisissez 0 s'il est loué dès le premier jour."]],
  unit_count: [["How many units are there?"], ["Combien y a-t-il de logements\u00a0?"]],
  unit_rent_monthly: [["What rent will each unit get per month?"], ["Quel loyer mensuel chaque logement obtiendra-t-il\u00a0?"]],
  stabilized_occupancy_pct: [["Once full, what share of the year will units be rented?", "95 means about 5% vacancy."], ["Une fois l'immeuble rempli, quelle part de l'année les logements seront-ils loués\u00a0?", "95 signifie une vacance d'environ 5\u00a0%."]],
  other_income_annual: [["Any other income per year, such as parking or laundry?", "Leave blank if there is none."], ["D'autres revenus par année, comme le stationnement ou la buanderie\u00a0?", "Laissez vide s'il n'y en a pas."]],
  exit_cap_rate_pct: [["At what cap rate would a buyer value the finished building?", "Ask a broker if unsure; a higher rate means a lower value."], ["À quel taux de capitalisation un acheteur évaluerait-il l'immeuble terminé\u00a0?", "Demandez à un courtier au besoin\u00a0; un taux plus élevé donne une valeur plus basse."]],
  senior_loan_amount: [["How much will the lender advance?", "Enter 0 if you are not borrowing."], ["Quelle somme le prêteur avancera-t-il\u00a0?", "Saisissez 0 si vous n'empruntez pas."]],
  senior_rate_pct: [["What is the loan's interest rate?"], ["Quel est le taux d'intérêt du prêt\u00a0?"]],
  senior_amort_years: [["Over how many years is the loan paid down?"], ["Sur combien d'années le prêt est-il amorti\u00a0?"]],
  refinance_and_hold: [["How will this deal end?"], ["Comment ce projet se terminera-t-il\u00a0?"]],
  senior_io_months: [["For how many months is the construction loan interest-only?", "Enter 0 if there is no interest-only period."], ["Pendant combien de mois le prêt de construction est-il à intérêts seulement\u00a0?", "Saisissez 0 s'il n'y a pas de période à intérêts seulement."]],
  refinance_month: [["In which month will you refinance?", "Count from the start of the project."], ["À quel mois refinancerez-vous\u00a0?", "Comptez à partir du début du projet."]],
  refinance_amount: [["What will the refinance loan amount be?", "Give this amount or the loan-to-value below, not both."], ["Quel sera le montant du prêt de refinancement\u00a0?", "Indiquez ce montant ou le ratio prêt-valeur ci-dessous, pas les deux."]],
  refinance_ltv_pct: [["What loan-to-value will the refinance use?", "Give this percentage or the loan amount above, not both."], ["Quel ratio prêt-valeur sera utilisé pour le refinancement\u00a0?", "Indiquez ce pourcentage ou le montant du prêt ci-dessus, pas les deux."]],
  refinance_rate_pct: [["What is the refinance loan's interest rate?"], ["Quel est le taux d'intérêt du prêt de refinancement\u00a0?"]],
  refinance_mli_select_points: [["How many MLI Select points are stated?"], ["Combien de points MLI Select sont déclarés\u00a0?"]],
  refinance_term_years: [["What is the refinance loan term in years?"], ["Quelle est la durée du prêt de refinancement en années\u00a0?"]],
  refinance_amort_years: [["Over how many years is the refinance loan paid down?"], ["Sur combien d'années le prêt de refinancement est-il amorti\u00a0?"]],
  refinance_io_months: [["For how many months is the refinance loan interest-only?", "Leave blank if there is no interest-only period."], ["Pendant combien de mois le prêt de refinancement est-il à intérêts seulement\u00a0?", "Laissez vide s'il n'y a pas de période à intérêts seulement."]],
  refinance_premium_tax_pct: [["What is the provincial tax on the insurance premium?", "It is paid in cash at the refinance. Leaving this blank means no provincial tax on the premium."], ["Quelle est la taxe provinciale sur la prime d’assurance hypothécaire\u00a0?", "Elle est payée comptant au refinancement. Laisser ce champ vide signifie aucune taxe provinciale sur la prime."]],
  refinance_insurance_premium_pct: [["What is the refinance mortgage insurance premium?", "For an insured (CMHC) loan. Leaving this blank means no mortgage insurance."], ["Quelle est la prime d'assurance hypothécaire du refinancement\u00a0?", "Pour un prêt assuré (SCHL). Laisser ce champ vide signifie aucune assurance hypothécaire."]],
  development_charges: [["What will development charges (DCs or DCCs) cost?", "Enter 0 if there are none, or if your soft or other costs already include them."], ["Combien coûteront les redevances de développement\u00a0?", "Saisissez 0 s'il n'y en a pas, ou si vos coûts indirects ou autres coûts les incluent déjà."]],
  property_tax_annual: [["What will property tax cost per year?", "Enter 0 if there is none, or if your expense ratio or fixed operating costs already include it."], ["Combien coûtera la taxe foncière par année\u00a0?", "Saisissez 0 s'il n'y en a pas, ou si votre ratio des charges ou vos charges d'exploitation fixes l'incluent déjà."]],
  land_transfer_tax: [["What will land transfer tax cost?", "Leave blank if there is none, or if your soft or other costs already include it."], ["Combien coûteront les droits de mutation immobilière\u00a0?", "Laissez vide s'il n'y en a pas, ou si vos coûts indirects ou autres coûts les incluent déjà."]],
  gst_hst_net: [["What will GST/HST cost, net of the rental rebates?", "Leave blank if there is none, or if your soft or other costs already include it."], ["Combien coûtera la TPS/TVH, nette des remboursements pour logement locatif\u00a0?", "Laissez vide s'il n'y en a pas, ou si vos coûts indirects ou autres coûts l'incluent déjà."]],
};
const GROUPS: Record<string, [string, string]> = {
  sale: ["Unit sales", "Ventes des unités"],
  budget: ["Budget", "Budget"], revenue: ["Revenue", "Revenus"], timeline: ["Timeline", "Échéancier"], operations: ["Operations", "Exploitation"],
  exit: ["Exit", "Sortie"], senior: ["Senior loan", "Prêt principal"], mezzanine: ["Mezzanine loan", "Prêt mezzanine"], equity: ["Equity", "Fonds propres"],
  refinance: ["Refinance", "Refinancement"], waterfall: ["LP/GP split", "Partage commanditaires-commandité"], stated: ["Stated figures (checks)", "Chiffres déclarés (contrôles)"],
};



const DRIVERS_L: Record<string, [string, string]> = {
  pricePct: ["Sale prices", "Prix de vente"],
  absorptionPct: ["Sales pace", "Rythme de vente"],
  presalesPts: ["Presales", "Préventes"],
  exitCapBps: ["Exit cap rate", "Taux de sortie"],
  rentPct: ["Rents", "Loyers"],
  occupancyPts: ["Occupancy", "Occupation"],
  costPct: ["Development costs", "Coûts de développement"],
  expensePts: ["Operating costs", "Charges d'exploitation"],
  rateBps: ["Interest rates", "Taux d'intérêt"],
  constructionMonths: ["Construction period", "Durée de construction"],
  leaseUpMonths: ["Lease-up period", "Période de location"],
};
const BE_UNIT: Record<string, string> = { pricePct: "%", absorptionPct: "%", presalesPts: "pts", rentPct: "%", costPct: "%", exitCapBps: "bps", rateBps: "bps", occupancyPts: "pts" };
type BreakevenText = { driver: string; state: string; shock: number | null; limit: number; to: { key: string; item?: string; to: number; unit: string }[] };
const VERDICT: Record<string, [string, string]> = {
  APPROVE: ["Approve", "Approuver"],
  APPROVE_WITH_CONDITIONS: ["Approve with conditions", "Approuver sous conditions"],
  REJECT: ["Reject", "Rejeter"],
  NOT_EVALUATED: ["Not evaluated", "Non évalué"],
};
const DECISION: Record<string, [string, string]> = {
  approve: ["Approve", "Approuver"],
  approve_with_conditions: ["Approve with conditions", "Approuver sous conditions"],
  reject: ["Reject", "Rejeter"],
  return_to_underwriting: ["Return to underwriting", "Renvoyer à l'analyse"],
};
const ROLES: Record<string, [string, string]> = {
  owner: ["owner", "propriétaire"], admin: ["admin", "administrateur"], analyst: ["analyst", "analyste"], viewer: ["viewer", "lecteur"], reviewer: ["reviewer", "réviseur"], client: ["client", "client"],
};
const ASSETS: Record<string, string> = {
  Multifamily: "Multilogement", "Mixed-use": "Usage mixte", Industrial: "Industriel", Office: "Bureaux", Retail: "Commerce de détail",
  Hospitality: "Hôtellerie", "Self storage": "Entreposage libre-service", Other: "Autre",
};

const BUDGET_LINES: Record<string, string> = { land: "terrain", hard: "coûts directs", soft: "coûts indirects", contingency: "provision pour imprévus", other: "autres coûts", developmentCharges: "redevances de développement", landTransferTax: "droits de mutation immobilière", gstHstNet: "TPS/TVH nette des remboursements" };
const LOANS: Record<string, string> = { "senior loan": "prêt principal", "mezzanine loan": "prêt mezzanine", "refinance loan": "prêt de refinancement" };
const frNum = (x: string) => Number(x).toLocaleString("fr-CA");
const frPct = (x: string) => `${frNum(x)}\u00a0%`;

// ---- Messages produced by the engine and the API, in French ----------------------------------
const SALE_SHARES: Record<string, string> = {
  "presold share": "La part prévendue",
  deposit: "Le dépôt",
  "sales commission": "La commission de vente",
  "lender's presale threshold": "Le seuil de prévente du prêteur",
};

const FR_REASONS: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
  [/^The document states a scale for this amount that Agir cannot read safely$/, "Le document indique pour ce montant une échelle qu’Agir ne peut pas lire avec certitude"],
  [/^The AI amount is under \$1,000; check whether the document states it in thousands or millions$/, "Le montant IA est inférieur à 1 000 $; vérifiez si le document l’exprime en milliers ou en millions"],
  [/^One soft-cost item \(a permit\), not the total soft cost; enter the total$/, "Un poste des coûts indirects (un permis), pas le total des coûts indirects ; entrez le total"],
  [/^(.+\.) The documents state (.+) units in all; the types read so far have (.+)\.$/, m => `${translateMessage(m[1])} Les documents indiquent ${m[2]} logements au total ; les types lus jusqu’ici en comptent ${m[3]}.`],
  [/^The 1 unit of type (.+) has no rent in the documents\.$/, m => `Les documents ne donnent aucun loyer pour le logement de type ${m[1]}.`],
  [/^The (.+) units of type (.+) have no rent in the documents\.$/, m => `Les documents ne donnent aucun loyer pour les ${m[1]} logements de type ${m[2]}.`],
  [/^Type (.+) has a rent of (.+) a month but no unit count in the documents\.$/, m => `Les documents donnent un loyer de ${m[2]} par mois pour le type ${m[1]}, mais aucun nombre de logements.`],
  [/^The (.+) SF of space (.+) have no rent per SF in the documents\.$/, m => `Les documents ne donnent aucun loyer par pi² pour les ${m[1]} pi² de l’espace ${m[2]}.`],
  [/^Space (.+) has a rent of (.+) per SF a year but no rentable area in the documents\.$/, m => `Les documents donnent un loyer de ${m[2]} par pi² par an pour l’espace ${m[1]}, mais aucune superficie locative.`],
  [/^Type (.+) has no rent in the documents\.$/, m => `Les documents ne donnent aucun loyer pour le type ${m[1]}.`],
  [/^Give a reason for the threshold change$/, "Indiquez le motif de la modification du seuil"],
  [/^Published table$/, "Tableau publié"],
  [/^This table option is not available\. Review the current proposals\.$/, "Cette option du tableau n’est pas disponible. Consultez les propositions actuelles."],
  [/^approve the unit counts first$/, "Approuvez d’abord les nombres de logements"],
  [/^Alberta transfer of land fee \(no land transfer tax\)$/, "Frais de transfert de terrain en Alberta (aucun droit de mutation)"],
  [/^Saskatchewan title transfer fee \(no land transfer tax\)$/, "Frais de transfert de titre en Saskatchewan (aucun droit de mutation)"],
  [/^Newfoundland and Labrador deed registration fee \(no land transfer tax\)$/, "Frais d’enregistrement d’acte à Terre-Neuve-et-Labrador (aucun droit de mutation)"],
  [/^Mortgage registration fees belong in soft costs\.$/, "Les frais d’enregistrement hypothécaire font partie des coûts indirects."],
  [/^Ontario retail sales tax on insurance premiums$/, "Taxe de vente au détail de l’Ontario sur les primes d’assurance"],
  [/^Saskatchewan PST on mortgage default insurance$/, "TVP de la Saskatchewan sur l’assurance prêt hypothécaire"],
  [/^Quebec tax on insurance premiums, premium paid by 2026-12-31$/, "Taxe du Québec sur les primes d’assurance, prime payée au plus tard le 2026-12-31"],
  [/^Quebec tax on insurance premiums, premium paid after 2026-12-31$/, "Taxe du Québec sur les primes d’assurance, prime payée après le 2026-12-31"],
  [/^no verified public table; enter the rate \(0 if none\)$/, "Aucun tableau public vérifié ; saisissez le taux (0 s’il n’y en a pas)"],
  [/^MLI Select at 50 points lends up to 85% loan-to-value; enter the premium yourself\.$/, "MLI Select à 50 points permet un ratio prêt-valeur maximal de 85 % ; saisissez la prime vous-même."],
  [/^Published table past its re-check date \(([^)]+)\); check the source before relying on this value\.$/, (m) => `Tableau publié dont la date de revérification (${m[1]}) est passée ; vérifiez la source avant de vous fier à cette valeur.`],
  [/^Why GST\/HST net is \$0$/, "Pourquoi la TPS/TVH nette est de 0 $"],
  [/^refinance premium tax must be a number from (\d+) to (\d+)$/, (m) => `La taxe provinciale sur la prime du refinancement doit se situer entre ${frPct(m[1]!)} et ${frPct(m[2]!)}`],
  [/^British Columbia$/, "Colombie-Britannique"],
  [/^Ontario, outside Toronto$/, "Ontario, hors de Toronto"],
  [/^Ontario, outside Toronto, land with one or two single\-family homes$/, "Ontario, hors de Toronto, terrain avec une ou deux maisons unifamiliales"],
  [/^Toronto, land with one or two single\-family homes$/, "Toronto, terrain avec une ou deux maisons unifamiliales"],
  [/^Most municipalities$/, "La plupart des municipalités"],
  [/^New Brunswick$/, "Nouveau-Brunswick"],
  [/^Prince Edward Island$/, "Île-du-Prince-Édouard"],
  [/^CMHC MLI Standard$/, "SCHL MLI Standard"],
  [/^Appears to qualify for the purpose\-built rental rebate$/, "Semble admissible au remboursement pour immeubles locatifs construits à cette fin"],
  [/^Tax is on fair market value; the land cost stands in for it\. The source page gives no date\.$/, "La taxe porte sur la juste valeur marchande ; le coût du terrain est utilisé à sa place. La page source ne donne aucune date."],
  [/^Toronto's administration fee \(\$102\.56 \+ HST\) belongs in soft costs\.$/, "Les frais administratifs de Toronto (102,56 $ + TVH) font partie des coûts indirects."],
  [/^A municipality may charge up to 3% above \$500,000\.$/, "Une municipalité peut imposer jusqu’à 3 % sur la tranche supérieure à 500 000 $."],
  [/^1% of the greater of the price and the assessed value; the land cost stands in for both\. Use the assessed value if it is higher\.$/, "1 % du plus élevé du prix et de la valeur imposable ; le coût du terrain est utilisé pour les deux. Utilisez la valeur imposable si elle est supérieure."],
  [/^At least 4 units each with its own kitchen, bathroom and living area or at least 10 private rooms or suites; at least 90% held for long\-term rental; construction begins after 2023\-09\-13 and before 2031; substantial completion before 2036\.$/, "Au moins 4 logements ayant chacun une cuisine, une salle de bains et un espace de séjour ou au moins 10 chambres ou suites privées ; au moins 90 % sont conservés pour la location à long terme ; les travaux commencent après le 2023-09-13 et avant 2031 ; l’achèvement substantiel a lieu avant 2036."],
  [/^At least 4 units each with its own kitchen, bathroom and living area or at least 10 private rooms or suites; at least 90% held for long\-term rental; construction begins after 2023\-09\-13 and before 2031; substantial completion before 2036\. Provincial part only if construction begins after 2024\-11\-14 and before 2028 and completes before 2030\.$/, "Au moins 4 logements ayant chacun une cuisine, une salle de bains et un espace de séjour ou au moins 10 chambres ou suites privées ; au moins 90 % sont conservés pour la location à long terme ; les travaux commencent après le 2023-09-13 et avant 2031 ; l’achèvement substantiel a lieu avant 2036. La part provinciale s’applique seulement si les travaux commencent après le 2024-11-14 et avant 2028, et s’achèvent avant 2030."],
  [/^At least 4 units each with its own kitchen, bathroom and living area or at least 10 private rooms or suites; at least 90% held for long\-term rental; construction begins after 2023\-09\-13 and before 2031; substantial completion before 2036\. Provincial part is rebated up to \$35,000 per unit only for completion before 2029\.$/, "Au moins 4 logements ayant chacun une cuisine, une salle de bains et un espace de séjour ou au moins 10 chambres ou suites privées ; au moins 90 % sont conservés pour la location à long terme ; les travaux commencent après le 2023-09-13 et avant 2031 ; l’achèvement substantiel a lieu avant 2036. La part provinciale est remboursée jusqu’à 35 000 $ par logement seulement si l’achèvement a lieu avant 2029."],
  [/^CMHC MLI Select, (\d+) points$/, (m) => `SCHL MLI Select, ${m[1]} points`],
  [/^MLI Select points must be a whole number from (\d+) to (\d+)$/, (m) => `Le nombre de points MLI Select doit être un entier de ${frNum(m[1]!)} à ${frNum(m[2]!)}`],
  [/^refinance term must be a whole number from (\d+) to (\d+)$/, (m) => `La durée du prêt de refinancement doit être un nombre entier de ${frNum(m[1]!)} à ${frNum(m[2]!)} ans`],
  [/^Quebec has no full QST rebate for purpose-built rentals /, "Le Québec n’offre aucun remboursement intégral de la TVQ pour les immeubles locatifs construits à cette fin (le remboursement intégral couvre uniquement la TPS). La TVQ de 9,975 % sur la juste valeur marchande à l’achèvement est payable, moins un remboursement pouvant atteindre 7 182 $ par logement, qui est nul à partir de 225 000 $ par logement. Saisissez le montant net."],
  [/^the deal has no province$/, "La province du projet n’est pas indiquée"],
  [/^these tables are for deals in Canada; enter the amount yourself$/, "Ces tableaux valent pour les projets au Canada\u00a0; indiquez le montant vous-même"],
  [/^state the land cost first$/, "Indiquez d’abord le coût du terrain"],
  [/^approve the land cost first$/, "Approuvez d’abord le coût du terrain"],
  [/^the table needs a loan-to-value$/, "Le tableau exige un ratio prêt-valeur"],
  [/^state the refinance amortization first$/, "Indiquez d’abord l’amortissement du refinancement"],
  [/^CMHC multi-unit insurance needs at least 5 units; enter the premium yourself$/, "L’assurance multilogement de la SCHL exige au moins 5 logements ; saisissez la prime vous-même"],
  [/^The table is not effective yet or is past its re-check date; enter the value yourself\.$/, "Le tableau n’est pas encore en vigueur ou sa date de vérification est dépassée ; saisissez la valeur vous-même."],
  [/^no verified public table; enter the amount$/, "Aucun tableau public vérifié ; saisissez le montant"],
  [/^the purpose-built rental rebate needs 4\+ rental units; the NRRP rebate is entered by a person$/, "Le remboursement pour immeubles locatifs construits à cette fin exige au moins 4 logements locatifs ; une personne doit saisir le remboursement pour immeubles locatifs neufs"],
  [/^the table charges per five-year period; enter the premium yourself$/, "Le tableau facture par période de cinq ans ; saisissez la prime vous-même"],
  [/^The loan-to-value is outside this product's premium table; enter the premium yourself\.$/, "Le ratio prêt-valeur dépasse les limites du tableau des primes de ce produit ; saisissez la prime vous-même."],
  [/^The further 2% above \$3,000,000 and its rental exemption need a person; enter the amount\.$/, "Les 2 % supplémentaires au-delà de 3 000 000 $ et leur exemption locative exigent l’examen d’une personne ; saisissez le montant."],
  [/^Read by OCR from (\d+) scanned pages?\. Check every value against the page before approving it\.$/, (m) => `Lu par reconnaissance optique à partir de ${m[1]} ${m[1] === "1" ? "page numérisée" : "pages numérisées"}. Vérifiez chaque valeur sur la page avant de l'approuver.`],
  [/^This scanned PDF has more than 50 pages; Agir reads scans of up to 50 pages\. Split it, or enter its values by hand\.$/, "Ce PDF numérisé dépasse 50 pages ; Agir lit les numérisations de 50 pages au plus. Divisez-le ou saisissez ses valeurs à la main."],
  [/^OCR is not available on this machine$/, "La reconnaissance optique n'est pas disponible sur cette machine"],
  [/^This link is not available\. It may have expired or been revoked\.$/, "Ce lien n'est pas disponible. Il a peut-être expiré ou été révoqué."],
  [/^Only a finished report can be shared\.$/, "Seul un rapport terminé peut être partagé."],
  [/^This link is already revoked\.$/, "Ce lien est déjà révoqué."],
  [/^Too many requests\. Wait a minute\.$/, "Trop de demandes. Attendez une minute."],
  [/^This deal has no LP\/GP split, so it has no partner memo\.$/, "Ce projet n'a pas de partage commanditaires/commandité ; il n'a donc pas de note aux partenaires."],
  [/^This driver does not apply to this deal\.$/, "Cette hypothèse ne s'applique pas à ce projet."],
  [/^The inputs do not give this a meaningful value\.$/, "Les données ne permettent pas d'en tirer une valeur significative."],
  [/^Total development cost is zero\.$/, "Le coût total de développement est nul."],
  [/^Stabilized NOI is not positive, so the deal cannot be capitalized\.$/, "Le RNE stabilisé n'est pas positif ; le projet ne peut pas être capitalisé."],
  [/^Final-year NOI is not positive, so the asset has no capitalized value\.$/, "Le RNE de la dernière année n'est pas positif ; l'actif n'a pas de valeur capitalisée."],
  [/^The deal has no debt\.$/, "Le projet n'a pas de dette."],
  [/^No debt at stabilization\.$/, "Aucune dette à la stabilisation."],
  [/^No senior loan is in force in year 1\.$/, "Aucun prêt principal n'est en vigueur à l'année 1."],
  [/^No mezzanine loan\.$/, "Aucun prêt mezzanine."],
  [/^No rent to cover costs with\.$/, "Aucun loyer pour couvrir les coûts."],
  [/^No equity is contributed, so there is nothing to multiply\.$/, "Aucun fonds propre n'est apporté ; il n'y a rien à multiplier."],
  [/^No equity is contributed\.$/, "Aucun fonds propre n'est apporté."],
  [/^The equity cash flows have no rate of return \(no sign change\)\.$/, "Les flux des fonds propres n'ont pas de taux de rendement (aucun changement de signe)."],
  [/^The equity cash flows have (\d+) IRRs \((.+)\), so no single IRR is meaningful\.$/, (m) => `Les flux des fonds propres ont ${m[1]} TRI (${m[2]}) ; aucun TRI unique n'est significatif.`],
  [/^No refinance\.$/, "Aucun refinancement."],
  [/^A deal that is kept and refinanced needs its refinance: the month, the amount or loan-to-value, the rate and the amortization\.$/, "Un projet conservé et refinancé exige son refinancement : le mois, le montant ou le ratio prêt-valeur, le taux et l'amortissement."],
  [/^The deal is kept and refinanced, not sold\.$/, "Le projet est conservé et refinancé, non vendu."],
  [/^No debt is in force after the refinance\.$/, "Aucune dette n'est en vigueur après le refinancement."],
  [/^Cash left in the deal is 0 or below, so all of the equity has come back and there is nothing left to earn on\.$/, "L'encaisse restée dans le projet est de 0 ou moins : tous les fonds propres sont revenus et il ne reste rien sur quoi gagner un rendement."],
  [/^Only (\d+) months remain before the end of the hold, so this uses them, scaled to a year\.$/, (m) => `Il ne reste que ${m[1]} mois avant la fin de la détention ; ils sont utilisés ici, ramenés à une année.`],
  [/^The program has no dwelling units\.$/, "Le programme ne compte aucun logement."],
  [/^No LP\/GP split\.$/, "Aucun partage commanditaires-commandité."],
  [/^Deal returns are not meaningful\.$/, "Les rendements du projet ne sont pas significatifs."],
  [/^The LP cash flows have no single IRR\.$/, "Les flux des commanditaires n'ont pas de TRI unique."],
  [/^The GP cash flows have no single IRR\.$/, "Les flux du commandité n'ont pas de TRI unique."],
  // Extraction notes and document states.
  [/^Could be the (.+) or the (.+); enter the one to use$/, (m) => {
    const label = (text: string) => { const fr = FR_FIELDS[FIELDS.find(f => f.label.toLowerCase() === text)?.key ?? ""]; return fr ? fr.charAt(0).toLowerCase() + fr.slice(1) : text; };
    return `Il pourrait s’agir de ${label(m[1]!)} ou de ${label(m[2]!)} ; saisissez le champ à utiliser`;
  }],
  [/^One figure for both the (.+) and the (.+); enter each one$/, (m) => {
    const label = (text: string) => { const fr = FR_FIELDS[FIELDS.find(f => f.label.toLowerCase() === text)?.key ?? ""]; return fr ? fr.charAt(0).toLowerCase() + fr.slice(1) : text; };
    return `Un seul chiffre pour ${label(m[1]!)} et ${label(m[2]!)} ; saisissez chacun`;
  }],
  [/^read by OCR$/, () => "lu par ROC"],
  [/^please check$/, () => "à vérifier"],
  [/^your own label$/, () => "votre propre étiquette"],
  [/^Please check: (.+) is usually between (.+) and (.+)$/, (m) => `À vérifier : ${FR_FIELDS[FIELDS.find(f => f.label === m[1])?.key ?? ""] ?? m[1]} se situe habituellement entre ${m[2]} et ${m[3]}`],
  [/^(.+) is usually between (.+) and (.+)\. Please check before using this value\.$/, (m) => `${FR_FIELDS[FIELDS.find(f => f.label === m[1])?.key ?? ""] ?? m[1]} se situe habituellement entre ${m[2]} et ${m[3]}. Vérifiez avant d’utiliser cette valeur.`],
  [/^Chosen because it closes: (.+)$/, (m) => `Choisi car il confirme : ${translateMessage(`Checked: ${m[1]}`).replace(/^Vérifié : /, "")}`],
  [/^Checked: the costs read add up to the stated total cost of (.+)$/, (m) => `Vérifié : les coûts lus correspondent au coût total déclaré de ${m[1]}`],
  [/^Please check: this is more than the stated total cost of (.+)$/, (m) => `À vérifier : ce montant dépasse le coût total déclaré de ${m[1]}`],
  [/^Checked: the loan and total cost agree with the stated loan-to-cost of (.+)%$/, (m) => `Vérifié : le prêt et le coût total correspondent au ratio prêt-coût déclaré de ${m[1]} %`],
  [/^Checked: the unit types read add up to the stated total of (.+)$/, (m) => `Vérifié : les types de logements lus correspondent au total déclaré de ${m[1]}`],
  [/^Please check: the unit types read add up to (.+), the documents state (.+)$/, (m) => `À vérifier : les types de logements lus totalisent ${m[1]}, les documents indiquent ${m[2]}`],
  [/^Please check: this looks about 1,000 times off (.+)$/, (m) => `À vérifier : ce montant semble différer d’un facteur d’environ 1 000 de ${m[1]}`],
  [/^"(.+)" is an output figure, which is never taken as an input$/, (m) => `« ${m[1]} » est un résultat ; il n'est jamais retenu comme donnée`],
  [/^"(.+)" could be (.+) or (.+); the document does not group thousands with spaces elsewhere$/, (m) => `« ${m[1]} » peut se lire ${m[2]} ou ${m[3]} ; le document ne groupe pas les milliers par des espaces ailleurs`],
  [/^"(.+)" could be (.+) or (.+); the document does not say which$/, (m) => `« ${m[1]} » peut se lire ${m[2]} ou ${m[3]} ; le document ne précise pas lequel`],
  [/^"(.+)" uses a different decimal separator from the rest of the document$/, (m) => `« ${m[1]} » utilise un autre séparateur décimal que le reste du document`],
  [/^"(.+)" would be a figure with three decimal places, which money, counts and areas never have$/, (m) => `« ${m[1]} » aurait trois décimales, ce qu'un montant, un nombre ou une superficie n'a jamais`],
  [/^"(.+)" is not a well-formed number$/, (m) => `« ${m[1]} » n'est pas un nombre bien formé`],
  [/^page (\d+), line (\d+)$/, (m) => `page ${m[1]}, ligne ${m[2]}`],
  [/^line (\d+)$/, (m) => `ligne ${m[1]}`],
  [/^paragraph (\d+)$/, (m) => `paragraphe ${m[1]}`],
  [/^Approved earlier$/, "Approuvée précédemment"],
  [/^Entered by an analyst$/, "Saisie par un analyste"],
  [/^Default accepted$/, "Valeur par défaut acceptée"],
  [/^Its source document was removed; confirm or reject it$/, "Son document source a été retiré ; confirmez-la ou rejetez-la"],
  [/^Its source document was removed$/, "Son document source a été retiré"],
  [/^The label it was remembered from was removed; confirm or reject it$/, "L'étiquette dont elle avait été retenue a été retirée ; confirmez-la ou rejetez-la"],
  [/^The label it was remembered from was removed$/, "L'étiquette dont elle avait été retenue a été retirée"],
  [/^The documents give this as parts that add up to it: (.+)$/, (m) => `Les documents l’indiquent en parties dont la somme donne ce montant : ${m[1]}`],
  [/^Labelled the same way before in this workspace; confirm it$/, "Étiqueté de la même façon auparavant dans cet espace ; à confirmer"],
  [/^The AI field is unknown or cannot be read from documents$/, "Le champ IA est inconnu ou ne peut pas être lu dans les documents"],
  [/^The AI item does not match this field$/, "Le type IA ne correspond pas à ce champ"],
  [/^The AI document or address does not exist$/, "Le document ou l’adresse IA n’existe pas"],
  [/^The AI quote is not at this address$/, "La citation IA ne se trouve pas à cette adresse"],
  [/^The AI value is not written in its quote$/, "La valeur IA n’est pas écrite dans sa citation"],
  [/^The AI unit does not match this field$/, "L’unité IA ne correspond pas à ce champ"],
  [/^The AI read a financing figure as other costs; interest and lender fees are computed by Agir or belong to the stated interest reserve$/, "L’IA a lu un montant de financement comme autres coûts\u00a0; les intérêts et les frais du prêteur sont calculés par Agir ou relèvent de la réserve d’intérêts déclarée"],
  [/^Please check: the separator in this figure can be read more than one way; the AI read it as shown$/, "À vérifier : le séparateur de ce chiffre peut se lire de plus d’une façon; l’IA l’a lu comme indiqué"],
  [/^Please check: the separator in this figure could be a decimal point or a thousands group; the AI read it as shown$/, "À vérifier : le séparateur de ce chiffre pourrait être une virgule décimale ou un séparateur de milliers; l’IA l’a lu comme indiqué"],
  [/^Please check: every source is a low-confidence AI reading$/, "À vérifier : chaque source est une lecture IA de faible confiance"],
  [/^Rejected in review$/, "Rejetée à l'examen"],
  [/^Second approver declined$/, "Refusée par le second approbateur"],
  [/^Entered by (.+?)(: .*)?$/, (m) => `Saisie par ${m[1]}${m[2] ?? ""}`],
  // A document source, as a run lists it: "name, page 1, line 2" or "name, Sheet!C5", with a note when it was given in m².
  [/^(.+), converted from square metres \("(.+)"\)$/, (m) => `${translateMessage(m[1])}, converti de mètres carrés (« ${m[2]} »)`],
  [/^(.+?), (page \d+, line \d+|line \d+|paragraph \d+)$/, (m) => `${m[1]}, ${translateMessage(m[2])}`],
  [/^A document states this in (.+); this deal is in (CAD|USD|AUD)\. Enter the amount in \2\.$/, (m) => `Un document l'indique en ${m[1]!.replace(" and ", " et ")} ; ce dossier est en ${m[2]}. Saisissez le montant en ${m[2]}.`],
  [/^A document states this in (.+); this deal does not state its currency\. Enter the amount\.$/, (m) => `Un document l'indique en ${m[1]!.replace(" and ", " et ")} ; ce dossier n'indique pas sa devise. Saisissez le montant.`],
  [/^No field matches this label$/, "Aucun champ ne correspond à ce libellé"],
  [/^No budget line matches this label$/, "Aucune ligne de budget ne correspond à ce libellé"],
  [/^Another number on this line was used$/, "Un autre nombre de cette ligne a été retenu"],
  [/^Looks like .+, but the number is not written as .+\. Enter it by hand if it is\.$/, "Ressemble à un champ connu, mais le nombre n'est pas écrit dans l'unité attendue. Saisissez-le à la main s'il y a lieu."],
  [/^The file does not start like a PDF$/, "Le fichier ne commence pas comme un PDF"],
  [/^The file is not an Office (\w+) package$/, (m) => `Le fichier n'est pas un paquet Office ${m[1]}`],
  [/^A text file cannot contain binary data$/, "Un fichier texte ne peut pas contenir de données binaires"],
  [/^The text is not valid UTF-8$/, "Le texte n'est pas en UTF-8 valide"],
  [/^The stored file does not match the size that was uploaded$/, "Le fichier stocké ne correspond pas à la taille téléversée"],
  [/^The stored file does not match the fingerprint recorded at upload$/, "Le fichier stocké ne correspond pas à l'empreinte consignée au téléversement"],
  [/^The file is larger than 75 MB\.?$/, "Le fichier dépasse 75 Mo."],
  [/^This PDF is scanned pages with no text layer\./, "Ce PDF est composé de pages numérisées sans couche de texte. Agir ne fait pas encore de reconnaissance optique : saisissez ses valeurs à la main ou téléversez un PDF textuel."],
  [/^Agir could not process this file after several attempts\./, "Agir n'a pas pu traiter ce fichier après plusieurs tentatives. Relancez-le ou téléversez-le de nouveau."],
  [/^Agir could not read this file: (.+)$/, (m) => `Agir n'a pas pu lire ce fichier : ${m[1]}`],
  // API errors.
  [/^Your role in this workspace does not allow this action$/, "Votre rôle dans cet espace ne permet pas cette action"],
  // Card F: closing a workspace and deleting an account.
  [/^This workspace is closed\.$/, "Cet espace de travail est fermé."],
  [/^Say why the workspace is closing \(10 to 500 characters\)$/, "Indiquez pourquoi l’espace de travail ferme (de 10 à 500 caractères)"],
  [/^Close the workspaces you own before deleting your account\.$/, "Fermez les espaces de travail dont vous êtes propriétaire avant de supprimer votre compte."],
  [/^The figure's unit \((.+)\) does not fit (.+)$/, (m) => `L'unité du chiffre (${m[1]}) ne convient pas à ${m[2]}`],
  [/^The figure is outside what (.+) can hold$/, (m) => `Le chiffre est hors des limites de ${m[1]}`],
  [/^The figure is no longer in the document$/, "Le chiffre n'est plus dans le document"],
  [/^This field needs an item name$/, "Ce champ demande un nom d'élément"],
  [/^A reviewer is added by requesting Agir review$/, "Un réviseur est ajouté en demandant une révision Agir"],
  [/^This person is an Agir reviewer; their access is changed by requesting Agir review$/, "Cette personne fait partie de la révision Agir ; son accès se modifie en demandant une révision Agir"],
  [/^Review access lasts between 1 and 90 days$/, "L'accès de révision dure de 1 à 90 jours"],
  [/^Ownership is not granted by invitation$/, "La propriété d'un espace ne se donne pas par invitation"],
  [/^This invitation is not there any more\.$/, "Cette invitation n'existe plus."],
  // From fn_revoke_client_invite (migration 0019), which Withdraw and "Make a new link" both call.
  [/^This invitation is already used or revoked\.$/, "Cette invitation a déjà été utilisée ou annulée."],
  [/^Invitation not found$/, "Cette invitation n'existe plus."],
  [/^A client is added to a deal, not to the workspace$/, "Un client s'ajoute à un projet, pas à l'espace"],
  [/^No user with that email has an account$/, "Aucun compte n'existe avec ce courriel"],
  [/^The owner's role cannot be changed$/, "Le rôle du propriétaire ne peut pas être changé"],
  [/^This person is not a member of the workspace$/, "Cette personne n'est pas membre de l'espace"],
  [/^The owner cannot be removed from the workspace$/, "Le propriétaire ne peut pas être retiré de l'espace"],
  [/^This person is an Agir reviewer; end their review access instead$/, "Cette personne fait partie de la révision Agir\u00a0; mettez plutôt fin à son accès de révision"],
  [/^This person is a client; remove them from the deal instead$/, "Cette personne est un client\u00a0; retirez-la plutôt du projet"],
  [/^A workspace name is between 1 and 120 characters$/, "Le nom d'un espace compte de 1 à 120 caractères"],
  [/^This person has no review access to end$/, "Cette personne n'a pas d'accès de révision en cours"],
  [/^A name is between 1 and 120 characters$/, "Un nom compte de 1 à 120 caractères"],
  [/^This person is already a member of the workspace; a reviewer must be someone outside it$/, "Cette personne est déjà membre de l'espace ; un réviseur doit venir de l'extérieur de l'espace"],
  [/^Sign in to continue\.$/, "Connectez-vous pour continuer."],
  [/^That email and password do not match\.$/, "Ce courriel et ce mot de passe ne correspondent pas."],
  [/^That password is not right\.$/, "Ce mot de passe n'est pas le bon."],
  [/^That is already your email address\.$/, "C'est déjà votre adresse courriel."],
  [/^This link does not work any more\. It may have been used or expired\. Ask for a new one\.$/, "Ce lien ne fonctionne plus. Il a peut-être déjà servi ou expiré. Demandez-en un nouveau."],
  [/^This link does not work any more\. It may have been used already, or be more than 7 days old\.$/, "Ce lien ne fonctionne plus. Il a peut-être déjà servi, ou il date de plus de 7 jours."],
  [/^Too many attempts\. Wait a while and try again\.$/, "Trop de tentatives. Patientez un moment, puis réessayez."],
  [/^That code is not right, or it has expired\. Check the latest email or ask for a new code\.$/, "Ce code n'est pas le bon, ou il a expiré. Vérifiez le dernier courriel ou demandez un nouveau code."],
  [/^An account with that email already exists\.$/, "Un compte existe déjà avec ce courriel."],
  [/^Agir is by invitation during the pilot\.$/, "Agir est sur invitation pendant le projet pilote."],
  [/^Too many attempts\. Wait a minute\.$/, "Trop de tentatives. Patientez une minute."],
  [/^Some fields are missing or not valid\.$/, "Des champs manquent ou ne sont pas valides."],
  [/^Underwriting is blocked until review is clear\.$/, "L'analyse est bloquée jusqu'à la fin de l'examen."],
  [/^This run is not in progress\. It may have finished\.$/, "Cette analyse n'est pas en cours. Elle est peut-être terminée."],
  [/^This run needs a valid run token\.$/, "Cette analyse exige un jeton d'analyse valide."],
  [/^A run with this token is already in progress\.$/, "Une analyse avec ce jeton est déjà en cours."],
  [/^The connection closed before the run finished\. Open the deal again to see whether it was recorded\.$/, "La connexion s'est fermée avant la fin de l'analyse. Rouvrez le projet pour voir si elle a été enregistrée."],
  [/^No document states this value any more; to keep it, say why \(at least 10 characters\)$/, "Aucun document n'indique plus cette valeur ; pour la conserver, dites pourquoi (au moins 10 caractères)"],
  [/^Someone changed this value while you were looking at it\. Reload and try again\.$/, "Quelqu'un a modifié cette valeur pendant que vous la consultiez. Rechargez la page et réessayez."],
  [/^A conflict can only be resolved to one of the documented values\./, "Un conflit ne peut être résolu que par l'une des valeurs documentées. Utilisez « Saisir une autre valeur » pour déroger."],
  [/^Say why you are entering a different value \(at least 10 characters\)$/, "Expliquez pourquoi vous saisissez une autre valeur (au moins 10 caractères)"],
  [/^A document states this value; to reject it, say why \(at least 10 characters\)\.$/, "Un document indique cette valeur ; pour la rejeter, dites pourquoi (au moins 10 caractères)."],
  [/^Only a workspace in solo review can use its own value as stated; here a second person must confirm it$/, "Seul un espace de travail en examen individuel peut utiliser sa propre valeur comme déclarée ; ici, une seconde personne doit la confirmer"],
  [/^Only a value waiting for a second approver can be used as stated$/, "Seule une valeur qui attend un second approbateur peut être utilisée comme déclarée"],
  [/^Only the person who entered this value can use it as stated$/, "Seule la personne qui a saisi cette valeur peut l'utiliser comme déclarée"],
  [/^A second approver must be a different person from the one who entered the value$/, "Le second approbateur doit être une autre personne que celle qui a saisi la valeur"],
  [/^Say where this value comes from \(at least 10 characters\)$/, "Précisez d'où vient cette valeur (au moins 10 caractères)"],
  [/^This field already has a value; review it instead$/, "Ce champ a déjà une valeur ; examinez-la plutôt"],
  [/^This deal already has (.+); change its values instead\.$/, (m) => `Ce projet a déjà ${m[1]} ; modifiez plutôt ses valeurs.`],
  [/^State the conditions$/, "Précisez les conditions"],
  [/^The inputs changed after this run\. Run underwriting again before recording a decision\.$/, "Les données ont changé après cette analyse. Relancez l'analyse avant de consigner une décision."],
  [/^A newer run exists\. Decide on the latest run\.$/, "Une analyse plus récente existe. Décidez sur la plus récente."],
  [/^Approving against a (\w+) verdict needs a written reason/, "Approuver malgré le verdict exige une justification écrite (au moins 20 caractères)"],
  [/^Upload a PDF, Excel \(\.xlsx\), CSV, Word \(\.docx\) or text file\.$/, "Téléversez un fichier PDF, Excel (.xlsx), CSV, Word (.docx) ou texte."],
  [/^The file is empty\.$/, "Le fichier est vide."],
  [/^Only a document that could not be read can be retried$/, "Seul un document qui n'a pas pu être lu peut être relancé"],
  [/^Something went wrong on our side\. It has been logged\.$/, "Un problème est survenu de notre côté. Il a été consigné."],
  [/^Choose two different drivers\.$/, "Choisissez deux hypothèses différentes."],
  [/^The approved inputs changed while the run was being computed\. Run it again\.$/, "Les données approuvées ont changé pendant le calcul. Relancez l'analyse."],
  [/^Give the committee's reasoning/, "Indiquez les motifs du comité (au moins 10 caractères)"],
  [/^Give the reasoning \(at least 10 characters\)$/, "Indiquez les motifs (au moins 10 caractères)"],
  [/^Enter your name$/, "Entrez votre nom"],
  [/^Enter a deal name$/, "Entrez un nom de projet"],
  [/^Name too long \(120 characters at most\)$/, "Nom trop long (120 caractères au plus)"],
  [/^Deal name too long \(160 characters at most\)$/, "Nom de projet trop long (160 caractères au plus)"],
  [/^Location too long \(160 characters at most\)$/, "Emplacement trop long (160 caractères au plus)"],
  [/^Reasoning too long \(5,000 characters at most\)$/, "Motifs trop longs (5\u00a0000 caractères au plus)"],
  [/^Conditions too long \(5,000 characters at most\)$/, "Conditions trop longues (5\u00a0000 caractères au plus)"],
  [/^Reason too long \(2,000 characters at most\)$/, "Motif trop long (2\u00a0000 caractères au plus)"],
  // The engine's own checks (validateInput and readiness). Numbers in the sentence are written the French way.
  [/^budget (land|hard|soft|contingency|other|developmentCharges|landTransferTax|gstHstNet) must be a number of at least 0$/, (m) => `Le poste « ${BUDGET_LINES[m[1]!]} » du budget doit être un nombre positif ou nul`],
  [/^property tax must be a number of at least 0$/, "La taxe foncière doit être un nombre positif ou nul"],
  [/^refinance insurance premium must be a number from (\d+) to (\d+)$/, (m) => `La prime d'assurance du refinancement doit se situer entre ${frPct(m[1]!)} et ${frPct(m[2]!)}`],
  [/^a credit in other costs cannot take the total budget to 0 or below$/, "Un crédit dans les autres coûts ne peut pas ramener le budget total à 0 ou moins"],
  [/^a credit in other costs cannot be more than hard costs, soft costs and contingency together$/, "Un crédit dans les autres coûts ne peut pas dépasser l'ensemble des coûts directs, des coûts indirects et de la provision pour imprévus"],
  [/^A credit: reduces total cost$/, "Un crédit\u00a0: il réduit le coût total"],
  [/^A negative figure that does not say it is a credit$/, "Chiffre négatif dont rien n'indique qu'il s'agit d'un crédit"],
  [/^at least one revenue component is required$/, "Au moins une composante de revenus est requise"],
  [/^revenue component "(.+)" needs a unit count above 0$/, (m) => `La composante de revenus « ${m[1]} » exige un nombre d'unités supérieur à 0`],
  [/^revenue component "(.+)" needs a monthly rent$/, (m) => `La composante de revenus « ${m[1]} » exige un loyer mensuel`],
  [/^revenue component "(.+)" needs a rentable area above 0$/, (m) => `La composante de revenus « ${m[1]} » exige une superficie locative supérieure à 0`],
  [/^revenue component "(.+)" needs a rent per SF$/, (m) => `La composante de revenus « ${m[1]} » exige un loyer par pi²`],
  [/^revenue component "(.+)" occupancy must be between (\d+) and (\d+)$/, (m) => `L'occupation de la composante de revenus « ${m[1]} » doit se situer entre ${frPct(m[2]!)} et ${frPct(m[3]!)}`],
  [/^construction months must be a whole number from (\d+) to (\d+)$/, (m) => `La durée de construction doit être un nombre entier de mois, de ${frNum(m[1]!)} à ${frNum(m[2]!)}`],
  [/^lease-up months must be a whole number from (\d+) to (\d+)$/, (m) => `La période de location doit être un nombre entier de mois, de ${frNum(m[1]!)} à ${frNum(m[2]!)}`],
  [/^hold years must be a whole number from (\d+) to (\d+)$/, (m) => `La période de détention doit être un nombre entier d'années, de ${frNum(m[1]!)} à ${frNum(m[2]!)}`],
  [/^stabilized occupancy must be between (\d+) and (\d+)$/, (m) => `L'occupation stabilisée doit se situer entre ${frPct(m[1]!)} et ${frPct(m[2]!)}`],
  [/^an expense ratio or fixed operating costs are required$/, "Un ratio des charges d'exploitation ou des charges d'exploitation fixes est requis"],
  [/^give either an expense ratio or fixed operating costs, not both$/, "Indiquez soit un ratio des charges d'exploitation, soit des charges d'exploitation fixes, pas les deux"],
  [/^exit cap rate must be above (\d+)$/, (m) => `Le taux de capitalisation à la sortie doit être supérieur à ${frPct(m[1]!)}`],
  [/^selling costs must be from (\d+) to under (\d+) percent$/, (m) => `Les frais de vente doivent être de ${frPct(m[1]!)} à moins de ${frPct(m[2]!)}`],
  [/^(senior loan|mezzanine loan|refinance loan) amount must be at least (\d+)$/, (m) => `Le montant du ${LOANS[m[1]!]} doit être d'au moins ${frNum(m[2]!)}`],
  [/^(senior loan|mezzanine loan|refinance loan) rate must be at least (\d+)$/, (m) => `Le taux du ${LOANS[m[1]!]} doit être d'au moins ${frPct(m[2]!)}`],
  [/^(senior loan|mezzanine loan|refinance loan) amortization must be (\d+) to (\d+) years$/, (m) => `L'amortissement du ${LOANS[m[1]!]} doit être de ${frNum(m[2]!)} à ${frNum(m[3]!)} ans`],
  [/^(senior loan|mezzanine loan|refinance loan) interest-only months must be (\d+) to (\d+)$/, (m) => `La période d'intérêts seulement du ${LOANS[m[1]!]} doit être de ${frNum(m[2]!)} à ${frNum(m[3]!)} mois`],
  [/^refinance month must fall from stabilization \(month (-?\d+)\) to before the sale \(month (-?\d+)\)$/, (m) => `Le mois du refinancement doit se situer entre la stabilisation (mois ${frNum(m[1]!)}) et la vente (mois ${frNum(m[2]!)}), avant celle-ci`],
  [/^give the refinance either a loan amount or a loan-to-value, not both or neither$/, "Pour le refinancement, indiquez soit un montant de prêt, soit un ratio prêt-valeur\u00a0: l'un des deux, pas les deux ni aucun"],
  [/^LP share must be above (\d+) and below (\d+)$/, (m) => `La part des commanditaires doit être supérieure à ${frPct(m[1]!)} et inférieure à ${frPct(m[2]!)}`],
  [/^preferred return must be at least (\d+)$/, (m) => `Le rendement privilégié doit être d'au moins ${frPct(m[1]!)}`],
  [/^GP promote must be from (\d+) to (\d+)$/, (m) => `L'intéressement du commandité doit être de ${frPct(m[1]!)} à ${frPct(m[2]!)}`],
  // Selling the units (card 77).
  [/^unit sale details apply only to a deal that sells its units$/, "Les données de vente des unités ne s'appliquent qu'à un projet qui vend ses unités"],
  [/^a deal that sells its units cannot state rents$/, "Un projet qui vend ses unités ne peut pas déclarer de loyers"],
  [/^a deal that sells its units cannot have a refinance$/, "Un projet qui vend ses unités ne peut pas comporter de refinancement"],
  [/^a deal that sells its units cannot have a lease-up period$/, "Un projet qui vend ses unités ne peut pas comporter de période de location"],
  [/^a deal that sells its units needs its sale details$/, "Un projet qui vend ses unités exige ses données de vente"],
  [/^a deal that sells its units needs at least one unit type$/, "Un projet qui vend ses unités exige au moins un type d'unité"],
  [/^unit type "(.+)" needs a whole unit count above 0$/, (m) => `Le type d'unité « ${m[1]} » exige un nombre entier d'unités supérieur à 0`],
  [/^unit type "(.+)" needs a sale price of at least 0$/, (m) => `Le type d'unité « ${m[1]} » exige un prix de vente d'au moins 0\u00a0$`],
  [/^(presold share|deposit|sales commission|lender's presale threshold) must be between (\d+) and (\d+)$/, (m) => `${SALE_SHARES[m[1]!]} doit se situer entre ${frPct(m[2]!)} et ${frPct(m[3]!)}`],
  [/^sales pace must be above 0 units per month$/, "Le rythme de vente doit être supérieur à 0 unité par mois"],
  [/^months from completion to first closing must be a whole number of at least 0$/, "Le délai entre l'achèvement et la première conclusion de vente doit être un nombre entier de mois, d'au moins 0"],
  [/^carry per unsold unit must be at least 0$/, "Les frais de possession par unité non vendue doivent être d'au moins 0\u00a0$"],
  // Sale readiness (card 78).
  [/^Sell the units and keep and refinance cannot both be chosen$/, "La vente des logements et leur conservation avec refinancement ne peuvent pas être choisies ensemble"],
  [/^Unit types \(at least one, with a count and a sale price\)$/, "Types de logements (au moins un, avec un nombre et un prix de vente)"],
  [/^Sale price per unit \((.+)\)$/, (m) => `Prix de vente par logement (${m[1]})`],
  [/^(.+) does not apply when the units are sold$/, (m) => `${FR_FIELDS[FIELDS.find((f) => f.label === m[1])?.key ?? ""] ?? m[1]} ne s'applique pas lorsque les logements sont vendus`],
  [/^(.+) applies only when the units are sold$/, (m) => `${FR_FIELDS[FIELDS.find((f) => f.label === m[1])?.key ?? ""] ?? m[1]} ne s'applique que lorsque les logements sont vendus`],
  // The reasons readiness gives for a value that cannot be used.
  [/^not a number$/, "n'est pas un nombre"],
  [/^below the minimum of (-?[\d.]+)$/, (m) => `inférieur au minimum de ${frNum(m[1]!)}`],
  [/^above the maximum of (-?[\d.]+)$/, (m) => `supérieur au maximum de ${frNum(m[1]!)}`],
  [/^must be a whole number$/, "doit être un nombre entier"],
  [/^(.+) and (.+) are one item written two ways$/, (m) => `${m[1]} et ${m[2]} désignent un même élément écrit de deux façons`],
  [/^Reject the values of one, or enter them under one name\.$/, "rejetez les valeurs de l'un, ou saisissez-les sous un seul nom."],
  [/^(.+) (cannot be below|cannot be above|must be a whole number|needs a number)(.*)$/, (m) => `${m[1]} : ${m[2] === "cannot be below" ? "ne peut pas être inférieur à" : m[2] === "cannot be above" ? "ne peut pas être supérieur à" : m[2] === "must be a whole number" ? "doit être un nombre entier" : "exige un nombre"}${m[3]}`],
];

/** CMHC's names for the debt coverage ratio (DCR; in French CCD, as in its multi-unit reference guide), in place of the lenders' DSCR / RCSD. Whole words only. */


export function translateMessage(text: string | null | undefined): string {
  if (!text) return "";
  for (const [re, out] of FR_REASONS) {
    const m = text.match(re);
    if (m) return typeof out === "string" ? out : out(m);
  }
  return text;
}

// ---- Numbers --------------------------------------------------------------------------------


// ---- Context --------------------------------------------------------------------------------
function initialLang(): Lang {
  try {
    const saved = localStorage.getItem("agir.lang");
    if (saved === "en" || saved === "fr") return saved;
  } catch {
    /* storage unavailable: fall back to the browser */
  }
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

/** `terms`: plain words first (the default) or finance terms first; it is read from the device when not given. */
export function build(lang: Lang, setLang: (l: Lang) => void, terms: TermsPref = termsStore.getSnapshot()) {
  const dict = lang === "fr" ? FR : EN;
  const idx = lang === "fr" ? 1 : 0;
  /** The plain-words name of a metric or gate, when plain words come first and one exists. */
  const plainName = (kind: "metric" | "gate", key: string): string | undefined =>
    terms === "plain" ? ((dict as Record<string, Entry>)[`terms.${kind}.${key}`] as string | undefined) : undefined;
  const t = <K extends Key>(key: K, p: Record<string, any> = {}): any => {
    const e = dict[key] as Entry;
    return typeof e === "function" ? e(p) : e;
  };
  const f = numberFormat(lang);
  const L = {
    field: (key: string, item?: string | null) => {
      const base = lang === "fr" ? FR_FIELDS[key] ?? FIELD_BY_KEY.get(key)?.label ?? key : FIELD_BY_KEY.get(key)?.label ?? key;
      return plainTerm(lang, item ? `${base} (${item})` : base);
    },
    ask: (key: string) => (ASK[key]?.[idx] ?? [FIELD_BY_KEY.get(key)?.label ?? key]).map((x) => plainTerm(lang, x ?? "")),
    help: (key: string, en: string | null) => { const h = lang === "fr" ? FR_HELP[key] ?? en : en; return h && plainTerm(lang, h); },
    verify: (key: string) => lang === "fr" ? FR_VERIFY[key] : FIELD_BY_KEY.get(key)?.verify,
    absent: (key: string) => { const en = FIELD_BY_KEY.get(key)?.absentMeans ?? ""; return plainTerm(lang, lang === "fr" ? FR_ABSENT[key] ?? en : en); },
    /** One readiness item as a line of the review card: the field's name (with the item), then the reason when there is one; the engine's own sentence when it is about no single field. */
    item: (i: ReadinessItem) => {
      const sentence = (x: string) => { const o = msg(x); return o.charAt(0).toUpperCase() + o.slice(1); };
      // In French the field's name stands for the label, unless the label is a sentence of its own (two names for one item).
      if (i.detail && !(i.itemKey && /^(?:Rent|Units|Rentable area|Rent per SF) \(/.test(i.label))) return lang === "fr" ? `${translateMessage(i.label) !== i.label ? sentence(i.label) : L.field(i.fieldKey, i.itemKey)}\u00a0: ${msg(i.detail)}` : `${i.label}: ${i.detail}`;
      if (lang === "en") return i.label.charAt(0).toUpperCase() + i.label.slice(1);
      if (i.fieldKey === "unit_count" && !i.itemKey) return t("review.revenueProgram");
      return translateMessage(i.label) !== i.label || i.fieldKey === "input" ? sentence(i.label) : L.field(i.fieldKey, i.itemKey);
    },
    group: (g: string) => GROUPS[g]?.[idx] ?? g,
    metric: (key: string) => plainName("metric", key) ?? plainTerm(lang, (lang === "fr" ? FR_METRICS[key]?.[0] : METRIC_BY_KEY.get(key)?.label) ?? key),
    formula: (key: string) => (lang === "fr" ? FR_METRICS[key]?.[1] : METRIC_BY_KEY.get(key)?.formula) ?? "",
    stress: (key: string, en: string) => plainTerm(lang, plainStress(lang, key, STRESS[key]?.[idx] ?? en)),
    gate: (key: string, en: string) => plainName("gate", key) ?? plainTerm(lang, GATES[key]?.[idx] ?? en),
    driver: (key: string) => DRIVERS_L[key]?.[idx] ?? key,
    /** One breakeven row as text: the sentence for a value, the reason for any other state. Every figure is the engine's. */
    breakeven: (r: BreakevenText, gate: { key: string; label: string; threshold: number; unit: string }) => {
      const unit = BE_UNIT[r.driver] ?? "%";
      const mag = (v: number) => f.delta(Math.abs(v), unit).slice(1);
      if (r.state === "out_of_range") return lang === "fr" ? `Pas dans les limites de ${f.delta(r.limit, unit)}` : `Not within ${f.delta(r.limit, unit)}`;
      if (r.state === "no_effect") return lang === "fr" ? `Dans les limites de ${f.delta(r.limit, unit)}, cette hypothèse ne change pas le chiffre de ce critère.` : `Within ${f.delta(r.limit, unit)}, this input does not change this gate's figure.`;
      if (r.state === "not_monotonic") return lang === "fr" ? "Le critère ne varie pas de façon régulière avec cette hypothèse\u00a0; utilisez la grille." : "The gate does not move steadily with this input; use the grid.";
      const fr = lang === "fr";
      const to = r.to.map((e) => {
        const v = f.value(e.to, e.unit);
        switch (e.key) {
          case "price": return `${e.item}${fr ? "\u00a0" : ""}: ${v}`;
          case "absorption": return fr ? `rythme de vente ${f.value(e.to, "")} logements par mois` : `sales pace ${f.value(e.to, "")} units per month`;
          case "presales": return fr ? `prévendu ${v}` : `presold ${v}`;
          case "rent": return `${e.item}${fr ? "\u00a0" : ""}: ${v}`;
          case "cost": return fr ? `coût total ${v}` : `total cost ${v}`;
          case "exit_cap": return fr ? `taux de sortie ${v}` : `exit cap ${v}`;
          case "occupancy": return fr ? `occupation ${v}` : `occupancy ${v}`;
          case "senior_rate": return fr ? `prêt senior ${v}` : `senior ${v}`;
          case "mezzanine_rate": return `mezzanine ${v}`;
          default: return fr ? `refinancement ${v}` : `refinance ${v}`;
        }
      }).join("; ");
      const m = mag(r.shock!);
      const text = (fr
        ? { pricePct: `Les prix de vente devraient être ${m} plus élevés`, absorptionPct: `Le rythme de vente devrait être ${m} plus rapide`, presalesPts: `Les préventes devraient être ${m} plus élevées`, rentPct: `Les loyers devraient être ${m} plus élevés`, costPct: `Les coûts de développement devraient être ${m} plus bas`, exitCapBps: `Le taux de sortie devrait être ${m} plus bas`, rateBps: `Les taux d'intérêt devraient être ${m} plus bas`, occupancyPts: `L'occupation devrait être ${m} plus élevée` }
        : { pricePct: `Sale prices would need to be ${m} higher`, absorptionPct: `The sales pace would need to be ${m} faster`, presalesPts: `Presales would need to be ${m} higher`, rentPct: `Rents would need to be ${m} higher`, costPct: `Development costs would need to be ${m} lower`, exitCapBps: `The exit cap rate would need to be ${m} lower`, rateBps: `Interest rates would need to be ${m} lower`, occupancyPts: `Occupancy would need to be ${m} higher` }
      )[r.driver as "rentPct"];
      const g = L.gate(gate.key, gate.label).replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase());
      const thr = f.value(gate.threshold, gate.unit);
      return fr
        ? `${text}${to ? ` (${to})` : ""} pour que ${g} atteigne ${thr}. Les autres hypothèses sont fixes\u00a0; les changements combinés interagissent.`
        : `${text}${to ? ` (${to})` : ""} for ${g} to reach ${thr}. Other inputs are held; moves together interact.`;
    },
    verdict: (code: string) => VERDICT[code]?.[idx] ?? code,
    decision: (d: string) => DECISION[d]?.[idx] ?? d,
    role: (r: string) => ROLES[r]?.[idx] ?? r,
    asset: (a: string) => (lang === "fr" ? ASSETS[a] ?? a : a),
    place: (location: string, province: string | null) => placeLabel(location, province, lang),
    currency: (c: string | null) => {
      const names = CURRENCY_NAMES[c as Currency];
      if (!names) return t("deals.currencyNone") as string;
      return `${names[idx][0]!.toUpperCase()}${names[idx].slice(1)} (${c})`;
    },
  };
  const msg = (text: string | null | undefined) => plainTerm(lang, lang === "fr" ? translateMessage(text) : text ?? "");
  const err = (e: unknown) => msg(e instanceof Error ? e.message : String(e ?? ""));
  return { lang, setLang, terms, t, f, L, msg, err };
}

export type I18n = ReturnType<typeof build>;
const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("agir.lang", l);
    } catch {
      /* private window: the choice lasts for this tab */
    }
    document.documentElement.lang = l === "fr" ? "fr-CA" : "en";
  };
  const { terms } = useTerms();
  const value = useMemo(() => build(lang, setLang, terms), [lang, terms]);
  if (typeof document !== "undefined") document.documentElement.lang = lang === "fr" ? "fr-CA" : "en";
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("I18nProvider missing");
  return v;
}

// ---- Structured text shared by several screens ----------------------------------------------




/** The verdict's headline and explanation, in the chosen language, from the stored gates. A solo owner sets their own conditions. */
export function verdictText(i: I18n, v: VerdictLike, checks: CheckLike[], solo = false): { headline: string; explanation: string } {
  const r = sharedVerdictText(i.lang, i.f, i.L.gate, v, checks, solo);
  return { headline: plainTerm(i.lang, r.headline), explanation: plainTerm(i.lang, r.explanation) };
}

/** "five" and "four" are spelled out as the engine does, so a v1 verdict's other counts stay digits. */





/** A check's message in the chosen language, from its key and figures. */
export function checkText(i: I18n, c: CheckLike, ltcCeiling = 85): string {
  return plainTerm(i.lang, sharedCheckText(i.lang, i.f, i.L.gate, c, ltcCeiling));
}



export type OverviewLike = {
  step: string;
  documents: { total: number; processing: number; failed: number };
  /** A reconcile is queued or the AI reading is running: the review counts are not the ones Review will show yet. */
  updating?: boolean;
  review: { approved: number; needsReview: number; conflicting: number; awaitingSecond: number; missing: number; impossible: number; status: string };
  run: { verdict: string; fresh: boolean } | null;
  decision: { decision: string } | null;
  reports: number;
};

/** A deal's status line and next action, from its evidence, in the chosen language. */
export function dealStatus(i: I18n, o: OverviewLike, solo = false): { tone: "pass" | "review" | "stop" | "neutral"; text: string; next: string; blockedParts: string[] } {
  const { t, L } = i;
  const r = o.review;
  // Documents are optional evidence: a deal with values and no documents is read from its values, as the server's overview does.
  // A file that was rejected or could not be read gives nothing to review, so it counts as no document here.
  if (o.documents.total - o.documents.failed === 0 && r.approved + r.needsReview + r.conflicting + r.awaitingSecond === 0) return { tone: "neutral", text: t("status.noDocs"), next: t("next.upload"), blockedParts: [] };
  // Until the documents are read and the review rebuilt (the AI reading included), the counts would only change: say so instead.
  if (o.documents.processing > 0 || o.updating) {
    return {
      tone: "neutral",
      text: o.documents.processing > 0 ? t("status.reading", { n: o.documents.processing }) : t("shell.readingValues"),
      next: o.documents.failed ? t("next.retry", { n: o.documents.failed }) : t("next.wait"),
      blockedParts: [],
    };
  }
  if (r.status === "blocked") {
    // Card D1: red "Blocked" only for values that disagree or cannot be right, as the server's overview says; the rest waits for the person.
    const stop = !!(r.conflicting || r.impossible);
    const parts = (stop ? [
      r.conflicting && t("status.conflicts", { n: r.conflicting }),
      r.missing && t("status.missing", { n: r.missing }),
      r.needsReview && t("status.toReview", { n: r.needsReview }),
      r.awaitingSecond && t("status.awaiting", { n: r.awaitingSecond }),
      r.impossible && t("status.outOfRange", { n: r.impossible }),
    ] : [
      r.needsReview && t("status.toReview", { n: r.needsReview }),
      r.missing && t("status.missing", { n: r.missing }),
      r.awaitingSecond && t("status.awaiting", { n: r.awaitingSecond }),
    ]).filter(Boolean) as string[];
    return {
      tone: stop ? "stop" : "review",
      text: `${t(stop ? "status.blocked" : "status.needsYou")} · ${parts.join(", ")}`,
      next: r.conflicting ? t("next.resolve", { n: r.conflicting }) : r.missing ? t("next.enter", { n: r.missing }) : t("next.review"),
      blockedParts: parts,
    };
  }
  if (!o.run || !o.run.fresh) {
    return { tone: o.run ? "review" : "neutral", text: o.run ? t("status.outOfDate") : t("status.readyToRun"), next: o.run ? t("next.runAgain") : t("next.run"), blockedParts: [] };
  }
  if (!o.decision) {
    const v = o.run.verdict;
    return { tone: v === "APPROVE" ? "pass" : v === "REJECT" ? "stop" : "review", text: t("status.verdict", { v: L.verdict(v) }), next: t(solo ? "next.decideSolo" : "next.decide"), blockedParts: [] };
  }
  return {
    tone: o.decision.decision.startsWith("approve") ? "pass" : "stop",
    text: t("status.decided", { d: L.decision(o.decision.decision).toLowerCase() }),
    next: o.reports > 0 ? t("next.share") : t("next.memo"),
    blockedParts: [],
  };
}

export type { VerdictLike, CheckLike } from "@agir/contracts";
