// Strings for the audit area. Keys start with "audit.", and a "threshold." key only this screen uses.
import { register, type Entry, type FrenchOf } from "./entry";

export const en = {
  "audit.lead": "Every event is chained to the one before it by a hash, and nothing in this list can be edited or deleted. The audit package carries this deal's events with everything their hashes cover, and your workspace's chain, so it can be checked without Agir.",
  // Card S8: each workspace has a chain of its own, so the check covers this workspace's events only and names the
  // event where it breaks (at, the number shown as "Event N" in the list). Never the installation's count (QA item 21).
  "audit.checked": (p) => p.ok
    ? p.n === 1 ? "The check verified your workspace's chain: its one event matches its own contents."
      : `The check verified your workspace's chain: each of its ${p.n} events matches the event before it and its own contents.`
    : `The check found a break at event ${p.at}: its hash does not match the event before it or its own contents.`,
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
    // Every event of this deal is loaded: say whose events they are, so the workspace count beside the chain check reads as
    // a different number (QA card D5).
    if (!p.filtered) return p.n === 1 ? "1 event in this deal." : `${p.n} events in this deal.`;
    return p.n === 1 ? `Showing the only ${one}.` : `Showing all ${p.n} ${what}.`;
  },
  "audit.workspaceCovered": (p) => `The chain check covered ${p.n} ${p.n === 1 ? "event" : "events"} in your workspace and ${p.at === null ? "found no break" : `found a break at event ${p.at}`}.`,
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
  "audit.lead": "Chaque événement est lié au précédent par une empreinte, et rien dans cette liste ne peut être modifié ni supprimé. Le dossier d'audit contient les événements de ce projet avec tout ce que couvrent leurs empreintes, et la chaîne de votre espace de travail, si bien qu'on peut le vérifier sans Agir.",
  "audit.checked": (p) => p.ok
    ? p.n === 1 ? "La vérification a validé la chaîne de votre espace de travail\u00a0: son seul événement correspond à son propre contenu."
      : `La vérification a validé la chaîne de votre espace de travail\u00a0: chacun de ses ${p.n} événements correspond à l'événement précédent et à son propre contenu.`
    : `La vérification a trouvé une rupture à l'événement ${p.at}\u00a0: son empreinte ne correspond pas à l'événement précédent ou à son propre contenu.`,
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
    if (!p.filtered) return p.n === 1 ? "1 événement dans ce projet." : `${p.n} événements dans ce projet.`;
    return p.n === 1 ? `Affichage du ${one}.` : `Affichage des ${p.n} ${what}.`;
  },
  "audit.workspaceCovered": (p) => `La vérification de la chaîne a couvert ${p.n} ${p.n === 1 ? "événement" : "événements"} dans votre espace de travail et ${p.at === null ? "n'a trouvé aucune rupture" : `a trouvé une rupture à l'événement ${p.at}`}.`,
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
