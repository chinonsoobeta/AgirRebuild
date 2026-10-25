// Strings for the shell: the top bar, navigation and theme. Keys start with "shell.".
import type { Entry, FrenchOf } from "./entry";

export const en = {
  "shell.toDark": "Switch to dark mode",
  "shell.toLight": "Switch to light mode",
  "shell.brand": "Agir",
  "shell.mainNav": "Main",
  "shell.allDeals": "All deals",
} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {
  "shell.toDark": "Passer au mode sombre",
  "shell.toLight": "Passer au mode clair",
  "shell.brand": "Agir",
  "shell.mainNav": "Principal",
  "shell.allDeals": "Tous les projets",
};
