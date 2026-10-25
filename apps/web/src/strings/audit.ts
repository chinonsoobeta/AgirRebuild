// Strings for the audit area. Keys start with "audit.".
import type { Entry, FrenchOf } from "./entry";

export const en = {
  "audit.lead": "Every event is chained to the one before it by a hash. Nothing in this list can be edited or deleted, and anyone with the audit package can check it.",
  "audit.checked": (p) => p.ok
    ? `The check read all ${p.n} events Agir has recorded, in every workspace, from the first one; each hash matched the event before it and its own contents.`
    : `The check read ${p.n} events Agir has recorded, in every workspace, from the first one, and stopped at event ${p.at}: its hash does not match the event before it or its own contents.`,
  "audit.checking": "Checking the chain…",
  "audit.verifyAgain": "Verify the chain again",
  "audit.verifyFailed": "The chain could not be checked just now. Try again.",
  "audit.searchLabel": "Search the audit trail",
  "audit.searchHint": "Search events, for example “property tax”",
  "audit.chipsLabel": "Show events about",
  "audit.cat.all": "Everything",
  "audit.cat.values": "Values",
  "audit.cat.documents": "Documents",
  "audit.cat.runs": "Runs",
  "audit.cat.reports": "Decisions and reports",
  "audit.cat.sharing": "Sharing",
  "audit.seq": (p) => `Event ${p.n}`,
  "audit.shown": (p) => p.filtered ? `Showing the latest ${p.n} of ${p.m} matching events loaded.` : `Showing the latest ${p.n} of ${p.m} events loaded.`,
  "audit.capped": (p) => `Only the latest ${p.n} events of this deal are loaded here.`,
  "audit.older": "Show older events",
  "audit.package": "Download the audit package",
  "audit.noMatch": "No loaded event matches. Try another word or Everything.",
  "audit.empty": "No events yet.",
} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {
  "audit.lead": "Chaque événement est lié au précédent par une empreinte. Rien dans cette liste ne peut être modifié ni supprimé, et quiconque a le dossier d'audit peut le vérifier.",
  "audit.checked": (p) => p.ok
    ? `La vérification a lu les ${p.n} événements qu'Agir a consignés, dans tous les espaces de travail, depuis le premier ; chaque empreinte correspond à l'événement précédent et à son propre contenu.`
    : `La vérification a lu ${p.n} événements qu'Agir a consignés, dans tous les espaces de travail, depuis le premier, et s'est arrêtée à l'événement ${p.at} : son empreinte ne correspond pas à l'événement précédent ou à son propre contenu.`,
  "audit.checking": "Vérification de la chaîne…",
  "audit.verifyAgain": "Vérifier la chaîne de nouveau",
  "audit.verifyFailed": "La chaîne n'a pas pu être vérifiée pour l'instant. Réessayez.",
  "audit.searchLabel": "Chercher dans la piste d'audit",
  "audit.searchHint": "Chercher un événement, par exemple « impôt foncier »",
  "audit.chipsLabel": "Afficher les événements touchant",
  "audit.cat.all": "Tout",
  "audit.cat.values": "Valeurs",
  "audit.cat.documents": "Documents",
  "audit.cat.runs": "Analyses",
  "audit.cat.reports": "Décisions et rapports",
  "audit.cat.sharing": "Partage",
  "audit.seq": (p) => `Événement ${p.n}`,
  "audit.shown": (p) => p.filtered ? `Affichage des ${p.n} plus récents des ${p.m} événements correspondants chargés.` : `Affichage des ${p.n} plus récents des ${p.m} événements chargés.`,
  "audit.capped": (p) => `Seuls les ${p.n} événements les plus récents de ce projet sont chargés ici.`,
  "audit.older": "Afficher des événements plus anciens",
  "audit.package": "Télécharger le dossier d'audit",
  "audit.noMatch": "Aucun événement chargé ne correspond. Essayez un autre mot ou « Tout ».",
  "audit.empty": "Aucun événement pour l'instant.",
};
