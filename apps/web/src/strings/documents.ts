// Strings for the documents area. Keys start with "documents.".
import type { Entry, FrenchOf } from "./entry";

const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const en = {
  "documents.quickStart": "No documents? Use the quick start",
  "documents.role.autoD": "It reads each file and names a role you can change.",
  "documents.role.deal_sourceD": "The deal's own figures: budget, rent roll, term sheet.",
  "documents.role.evidenceD": "Appraisals, quotes, market studies.",
  "documents.role.contextD": "Kept with the deal, never read for values.",
  "documents.title": "Documents in this deal",
  "documents.count.read": (p) => `${p.n} read`,
  "documents.count.processing": (p) => `${p.n} still being read`,
  "documents.count.failed": (p) => `${p.n} could not be used`,
  "documents.col.role": "Role",
  "documents.stage.rejected": "Rejected when checked",
  "documents.stage.read_failed": "Could not be read",
  "documents.stage.extracted": "Read, values found",
  "documents.added": (p) => (p.name ? `added ${p.date} by ${p.name}` : `added ${p.date}`),
  "documents.change": "Change",
  "documents.noRole": "No role yet",
  "documents.ocr": "Read by OCR: check every value against the page before approving it.",
  "documents.toReview": "Go to Review",
  "documents.step.checked": "Checked",
  "documents.step.read": "Read",
  "documents.step.values": "Values found",
} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {
  "documents.quickStart": "Pas de documents ? Utilisez le démarrage rapide",
  "documents.role.autoD": "Agir lit chaque fichier et lui attribue un rôle que vous pouvez modifier.",
  "documents.role.deal_sourceD": "Les chiffres propres au projet : budget, rôle des loyers, lettre d'engagement.",
  "documents.role.evidenceD": "Évaluations, soumissions, études de marché.",
  "documents.role.contextD": "Conservé avec le projet, jamais lu pour en tirer des valeurs.",
  "documents.title": "Documents de ce projet",
  "documents.count.read": (p) => `${p.n} ${s(p.n, "lu", "lus")}`,
  "documents.count.processing": (p) => `${p.n} en cours de lecture`,
  "documents.count.failed": (p) => `${p.n} ${s(p.n, "inutilisable", "inutilisables")}`,
  "documents.col.role": "Rôle",
  "documents.stage.rejected": "Refusé à la vérification",
  "documents.stage.read_failed": "Lecture impossible",
  "documents.stage.extracted": "Lu, valeurs trouvées",
  "documents.added": (p) => (p.name ? `ajouté le ${p.date} par ${p.name}` : `ajouté le ${p.date}`),
  "documents.change": "Modifier",
  "documents.noRole": "Pas encore de rôle",
  "documents.ocr": "Lu par reconnaissance optique : vérifiez chaque valeur sur la page avant de l'approuver.",
  "documents.toReview": "Aller à l'examen",
  "documents.step.checked": "Vérifié",
  "documents.step.read": "Lu",
  "documents.step.values": "Valeurs trouvées",
};
