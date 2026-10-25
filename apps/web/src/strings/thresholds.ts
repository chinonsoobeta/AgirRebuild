// Strings for the shared thresholds editor. Keys start with "thresholds.".
import type { Entry, FrenchOf } from "./entry";

export const en = {
  "thresholds.show": "Show the thresholds",
} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {
  "thresholds.show": "Afficher les seuils",
};
