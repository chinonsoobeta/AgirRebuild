// Strings for the shared thresholds editor. Keys start with "thresholds.".
import { register, type Entry, type FrenchOf } from "./entry";

export const en = {
  "thresholds.show": "Show the thresholds",
  "thresholds.atLeast": (p) => `at least ${p.value}`,
  "thresholds.atMost": (p) => `at most ${p.value}`,
  "thresholds.setDeal": "set for this deal",
  "thresholds.setWorkspace": "set for the workspace",
  "thresholds.cited": "CMHC's cited rule",
  "thresholds.change": "Change a threshold for this deal (a reason is required)",
  "thresholds.ownerOnly": "Only the workspace owner changes thresholds.",
  "thresholds.policy.policy-v1": "Sale at the end of the hold",
  "thresholds.policy.rental-hold-draft": "Rental hold",
  "thresholds.policy.rental-hold-insured-draft": "Rental hold, CMHC MLI Select",
  "thresholds.policy.rental-hold-insured-standard-draft": "Rental hold, CMHC standard insurance",
  "thresholds.policy.rental-hold-insured-standard-short-draft": "Rental hold, CMHC standard insurance, term under 10 years",
  "thresholds.policy.for-sale-draft": "Units for sale",
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
  "thresholds.policy.policy-v1": "Vente à la fin de la détention",
  "thresholds.policy.rental-hold-draft": "Location conservée et refinancée",
  "thresholds.policy.rental-hold-insured-draft": "Location conservée et refinancée, MLI Select de la SCHL",
  "thresholds.policy.rental-hold-insured-standard-draft": "Location conservée et refinancée, assurance standard de la SCHL",
  "thresholds.policy.rental-hold-insured-standard-short-draft": "Location conservée et refinancée, assurance standard de la SCHL, durée de moins de 10 ans",
  "thresholds.policy.for-sale-draft": "Logements à vendre",
};

register(en, fr);
