// Strings for the shared thresholds editor. Keys start with "thresholds.".
import type { Entry, FrenchOf } from "./entry";

export const en = {
  "thresholds.show": "Show the thresholds",
  "thresholds.atLeast": (p) => `at least ${p.value}`,
  "thresholds.atMost": (p) => `at most ${p.value}`,
  "thresholds.setDeal": "set for this deal",
  "thresholds.setWorkspace": "set for the workspace",
  "thresholds.cited": "CMHC's cited rule",
  "thresholds.change": "Change a threshold for this deal (a reason is required)",
  "thresholds.ownerOnly": "Only the workspace owner changes thresholds.",
} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {
  "thresholds.show": "Afficher les seuils",
  "thresholds.atLeast": (p) => `au moins ${p.value}`,
  "thresholds.atMost": (p) => `au plus ${p.value}`,
  "thresholds.setDeal": "fixé pour ce projet",
  "thresholds.setWorkspace": "fixé pour l'espace de travail",
  "thresholds.cited": "règle citée de la SCHL",
  "thresholds.change": "Modifier un seuil pour ce projet (un motif est exigé)",
  "thresholds.ownerOnly": "Seul le propriétaire de l'espace de travail modifie les seuils.",
};
