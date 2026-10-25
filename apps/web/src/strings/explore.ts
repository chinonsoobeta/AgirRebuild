// Strings for the explore area. Keys start with "explore.".
import type { Entry, FrenchOf } from "./entry";

export const en = {
  "explore.action": "Explore changes",
  "explore.back": (p) => `Back to run ${p.n}`,
  "explore.helper": "Drag a slider and the figures re-run. The run itself does not change.",
  "explore.runShock": "from the run",
  "explore.gateNeeds": (p) => `The gate needs ${p.t}`,
  "explore.verdictWith": (p) => `${p.v} with these changes`,
  "explore.swing": (p) => `${p.lo} and ${p.hi}`,
  "explore.barLabel": (p) => `${p.d}: ${p.lo}; ${p.hi}`,
  "explore.gridBase": (p) => `The outlined cell is run ${p.n}.`,
  "explore.torLow": "Assumption down",
  "explore.torHigh": "Assumption up",
  "explore.showGrid": "Show as a grid",
  "explore.asRun": "as run",
  "explore.be.noneRun": (p) => `No gate fails in run ${p.n}, so there is nothing to make up. When one does, this table moves a single input as far as the gate needs, with every other input held at the run's value.`,
} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {
  "explore.action": "Explorer des changements",
  "explore.back": (p) => `Retour à l'analyse ${p.n}`,
  "explore.helper": "Déplacez un curseur et les chiffres sont recalculés. L'analyse elle-même ne change pas.",
  "explore.runShock": "par rapport à l'analyse",
  "explore.gateNeeds": (p) => `Le critère exige ${p.t}`,
  "explore.verdictWith": (p) => `${p.v} avec ces changements`,
  "explore.swing": (p) => `${p.lo} et ${p.hi}`,
  "explore.barLabel": (p) => `${p.d} : ${p.lo} ; ${p.hi}`,
  "explore.gridBase": (p) => `La cellule encadrée correspond à l'analyse ${p.n}.`,
  "explore.torLow": "Hypothèse à la baisse",
  "explore.torHigh": "Hypothèse à la hausse",
  "explore.showGrid": "Afficher sous forme de grille",
  "explore.asRun": "comme l'analyse",
  "explore.be.noneRun": (p) => `Aucun critère n'est en échec dans l'analyse ${p.n}, il n'y a donc rien à combler. Quand l'un d'eux échoue, ce tableau déplace une seule hypothèse aussi loin que le critère l'exige, toutes les autres restant aux valeurs de l'analyse.`,
};
