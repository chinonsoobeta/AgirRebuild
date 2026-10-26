// Strings for the share page, the read-only view a share link opens. Its keys keep the names they had elsewhere.
import { register, type Entry, type FrenchOf } from "./entry";

export const en = {
  "threshold.citedFailures": "Fails cited lender rules under Agir's standard",
  "auth.share.from": (p) => `${p.ws} shared this with you`,
  "auth.share.figures": "Key figures from the run",
  "auth.share.yield": (p) => (p.cap ? `${p.name} ${p.v} over a ${p.cap} cap` : `${p.name} ${p.v}`),
  "auth.share.draft": "The policy is a draft, not yet signed by credit.",
  "auth.share.unsigned": "The policy is not yet signed by credit.",
  "auth.share.printed": (p) => `Every figure is printed from run ${p.n} with its source recorded; nothing on this page is recomputed.`,
  "auth.share.files": "Files",
  "auth.share.count": (p) => (p.n === 1 ? "1 file" : `${p.n} files`),
  "auth.share.packageHint": "A copy of the run, its inputs, its decisions and the audit trail's hash chain, for anyone who wants to check the figures.",
  "auth.share.recorded": "Each time this link is opened, it is recorded in the deal's audit trail.",
  "reports.previewNotice": "This is what the person you share with sees. Opening it here is not counted.",
  "reports.previewBack": "Back to Reports",
} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {
  "threshold.citedFailures": "Règles citées du prêteur non respectées selon le standard d'Agir",
  "auth.share.from": (p) => `${p.ws} a partagé ceci avec vous`,
  "auth.share.figures": "Chiffres clés de l'analyse",
  "auth.share.yield": (p) => (p.cap ? `${p.name} de ${p.v} pour un taux de capitalisation de ${p.cap}` : `${p.name} de ${p.v}`),
  "auth.share.draft": "La politique est provisoire, pas encore approuvée par le crédit.",
  "auth.share.unsigned": "La politique n'est pas encore approuvée par le crédit.",
  "auth.share.printed": (p) => `Chaque chiffre est imprimé à partir de l'analyse ${p.n}, avec sa source consignée\u00a0; rien sur cette page n'est recalculé.`,
  "auth.share.files": "Fichiers",
  "auth.share.count": (p) => (p.n === 1 ? "1 fichier" : `${p.n} fichiers`),
  "auth.share.packageHint": "Une copie de l'analyse, de ses données, de ses décisions et de la chaîne de hachage de la piste d'audit, pour quiconque veut vérifier les chiffres.",
  "auth.share.recorded": "Chaque ouverture de ce lien est consignée dans la piste d'audit du projet.",
  "reports.previewNotice": "Voici ce que voit la personne avec qui vous partagez. L'ouvrir ici n'est pas compté.",
  "reports.previewBack": "Retour aux rapports",
};

register(en, fr);
