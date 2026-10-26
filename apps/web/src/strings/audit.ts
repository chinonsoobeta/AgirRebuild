// Strings for the audit area. Keys start with "audit.", and a "threshold." key only this screen uses.
import { register, type Entry, type FrenchOf } from "./entry";

export const en = {
  "audit.lead": "Every event is chained to the one before it by a hash, and nothing in this list can be edited or deleted. The audit package carries this deal's events with their hashes and the result of the chain check.",
  // The check walks every workspace's events (the chain is one chain); the count and the broken event are this workspace's (card B).
  "audit.checked": (p) => p.ok
    ? `The check read every event Agir has recorded, in every workspace, from the first one; each hash matched the event before it and its own contents. ${p.n} of those events are this workspace's.`
    : `The check read the events Agir has recorded, in every workspace, from the first one, and stopped at an event of ${p.mine ? "this workspace" : "another workspace"}: its hash does not match the event before it or its own contents.`,
  "audit.checking": "Checking the chain…",
  "audit.verifyAgain": "Verify the chain again",
  "audit.verifyFailed": "The chain could not be checked. Try again.",
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
  // Under the list: how much of what is loaded it shows, and whether older events are still on the server (more).
  "audit.shown": (p) => {
    const what = p.filtered ? "matching events" : "events";
    if (p.n < p.m) return `Showing the latest ${p.n} of ${p.m} ${what} loaded.`;
    if (p.n === 0) return "";
    const one = p.filtered ? "matching event" : "event";
    if (p.more) return p.n === 1 ? `Showing the only ${one} loaded so far.` : `Showing the ${p.n} ${what} loaded so far.`;
    return p.n === 1 ? `Showing the only ${one}.` : `Showing all ${p.n} ${what}.`;
  },
  "audit.capped": "Older events load when you ask for them.",
  "audit.older": "Show older events",
  "audit.package": "Download the audit package",
  "audit.noMatch": "No loaded event matches. Try another word or Everything.",
  "audit.empty": "No events yet.",
  "threshold.inherited": "Inherited value",
  "audit.thresholdChanged": (p: any) => `Changed a policy threshold: ${p.name} = ${p.value}. ${p.reason}`,
  "audit.title": "Audit trail",
  "audit.intact": (p) => `Chain intact · ${p.n} events`,
  "audit.broken": "Chain broken",
  "audit.col.event": "Event",
  "audit.col.who": "Who",
  "audit.col.when": "When",
  "audit.col.hash": "Hash",
  "audit.worker": "Agir worker",
  "audit.someone": "Someone with the link",
} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {
  "audit.lead": "Chaque événement est lié au précédent par une empreinte, et rien dans cette liste ne peut être modifié ni supprimé. Le dossier d'audit contient les événements de ce projet avec leurs empreintes et le résultat de la vérification de la chaîne.",
  "audit.checked": (p) => p.ok
    ? `La vérification a lu tous les événements qu'Agir a consignés, dans tous les espaces de travail, depuis le premier\u00a0; chaque empreinte correspond à l'événement précédent et à son propre contenu. ${p.n} de ces événements appartiennent à cet espace de travail.`
    : `La vérification a lu les événements qu'Agir a consignés, dans tous les espaces de travail, depuis le premier, et s'est arrêtée à un événement ${p.mine ? "de cet espace de travail" : "d'un autre espace de travail"}\u00a0: son empreinte ne correspond pas à l'événement précédent ou à son propre contenu.`,
  "audit.checking": "Vérification de la chaîne…",
  "audit.verifyAgain": "Vérifier la chaîne de nouveau",
  "audit.verifyFailed": "La chaîne n'a pas pu être vérifiée. Réessayez.",
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
  "audit.shown": (p) => {
    const what = p.filtered ? "événements correspondants" : "événements";
    if (p.n < p.m) return `Affichage des ${p.n} plus récents des ${p.m} ${what} chargés.`;
    if (p.n === 0) return "";
    const one = p.filtered ? "seul événement correspondant" : "seul événement";
    if (p.more) return p.n === 1 ? `Affichage du ${one} chargé jusqu'ici.` : `Affichage des ${p.n} ${what} chargés jusqu'ici.`;
    return p.n === 1 ? `Affichage du ${one}.` : `Affichage des ${p.n} ${what}.`;
  },
  "audit.capped": "Les événements plus anciens se chargent à votre demande.",
  "audit.older": "Afficher des événements plus anciens",
  "audit.package": "Télécharger le dossier d'audit",
  "audit.noMatch": "Aucun événement chargé ne correspond. Essayez un autre mot ou « Tout ».",
  "audit.empty": "Aucun événement pour l'instant.",
  "threshold.inherited": "Valeur héritée",
  "audit.thresholdChanged": (p: any) => `A modifié un seuil de politique\u00a0: ${p.name} = ${p.value}. ${p.reason}`,
  "audit.title": "Piste d'audit",
  "audit.intact": (p) => `Chaîne intacte · ${p.n} événements`,
  "audit.broken": "Chaîne rompue",
  "audit.col.event": "Événement",
  "audit.col.who": "Qui",
  "audit.col.when": "Quand",
  "audit.col.hash": "Empreinte",
  "audit.worker": "Processus Agir",
  "audit.someone": "Une personne ayant le lien",
};

register(en, fr);
