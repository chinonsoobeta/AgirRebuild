// Strings for the review area. Keys start with "review.".
import type { Entry, FrenchOf } from "./entry";

const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const en = {
  "review.tagBlocked": "Blocked",
  "review.b.aiCheck": (p) => `Check ${p.n} ${s(p.n, "figure", "figures")} the AI reader was unsure of.`,
  "review.andMore": (p) => `and ${p.n} more`,
  "review.conflictsTitle": "Where the documents disagree",
  "review.conflictsBody": "Pick the value this deal should use. Each choice keeps its source and your name in the audit trail.",
  "review.conflictFigures": (p) => `The documents give ${p.n} different figures`,
  "review.required": "Required",
  "review.pendingTitle": "Read from your documents, waiting for your approval",
  "review.approvedBy": (p) => (p.date ? `Approved by ${p.who}, ${p.date}` : `Approved by ${p.who}`),
  "review.recheck": (p) => `Re-check by ${p.date}`,
  "review.showAll": (p) => `Show all ${p.n}`,
  "review.showFewer": "Show fewer",
  "review.approvedFoot": "Every approval keeps its source and the name of the person who gave it in the audit trail.",
  "review.otherIntro": (p) => `${p.n} ${s(p.n, "figure", "figures")} in your documents ${s(p.n, "was", "were")} not used. They are shown so nothing is hidden, and you can label one as an input.`,
  "review.aside": "About this review",
  "review.thresholds": "Thresholds",
  "review.thresholdsBody": "What this deal is judged against. A change and its reason are recorded.",
  "review.madeChoice": (p) => `${p.field}: ${p.value}${p.dflt ? ", the default" : ""}${p.who || p.date ? `, ${p.dflt ? "accepted" : "chosen"}${p.who ? ` by ${p.you ? "you" : p.who}` : ""}${p.date ? ` on ${p.date}` : ""}` : ""}.`,
  "review.change": "Change",
  "review.modeSolo": "You review on your own. A material value you enter by hand is used right away and labelled as stated by you until someone else confirms it.",
  "review.modeTeam": "You review as a team. A material value someone enters by hand counts only once a second, different person confirms it.",
} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {
  "review.tagBlocked": "Bloqué",
  "review.b.aiCheck": (p) => `Vérifiez ${p.n} ${s(p.n, "chiffre", "chiffres")} dont le lecteur IA n'était pas sûr.`,
  "review.andMore": (p) => `et ${p.n} ${s(p.n, "autre", "autres")}`,
  "review.conflictsTitle": "Là où les documents divergent",
  "review.conflictsBody": "Choisissez la valeur que ce projet doit utiliser. Chaque choix conserve sa source et votre nom dans la piste d'audit.",
  "review.conflictFigures": (p) => `Les documents donnent ${p.n} chiffres différents`,
  "review.required": "Requise",
  "review.pendingTitle": "Lues dans vos documents, en attente de votre approbation",
  "review.approvedBy": (p) => (p.date ? `Approuvée par ${p.who} le ${p.date}` : `Approuvée par ${p.who}`),
  "review.recheck": (p) => `À revérifier d'ici le ${p.date}`,
  "review.showAll": (p) => `Tout afficher (${p.n})`,
  "review.showFewer": "Afficher moins",
  "review.approvedFoot": "Chaque approbation conserve sa source et le nom de la personne qui l'a donnée dans la piste d'audit.",
  "review.otherIntro": (p) => `${p.n} ${s(p.n, "chiffre", "chiffres")} de vos documents ${s(p.n, "n'a pas été utilisé", "n'ont pas été utilisés")}. Ils sont affichés pour que rien ne soit caché, et vous pouvez en libeller un comme donnée.`,
  "review.aside": "À propos de cet examen",
  "review.thresholds": "Seuils",
  "review.thresholdsBody": "Ce à quoi ce projet est comparé. Une modification et son motif sont consignés.",
  "review.madeChoice": (p) => `${p.field}\u00a0: ${p.value}${p.dflt ? ", valeur par défaut" : ""}${p.who || p.date ? `, ${p.dflt ? "acceptée" : "choix fait"}${p.who ? ` par ${p.you ? "vous" : p.who}` : ""}${p.date ? ` le ${p.date}` : ""}` : ""}.`,
  "review.change": "Modifier",
  "review.modeSolo": "Vous examinez seul. Une valeur déterminante saisie à la main est utilisée tout de suite et marquée comme déclarée par vous jusqu'à ce qu'une autre personne la confirme.",
  "review.modeTeam": "Vous examinez en équipe. Une valeur déterminante saisie à la main ne compte qu'une fois confirmée par une seconde personne, différente.",
};
