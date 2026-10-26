// Strings for the shell: the top bar, navigation and theme. Keys start with "shell.".
import { register, type Entry, type FrenchOf } from "./entry";

export const en = {
  "shell.toDark": "Switch to dark mode",
  "shell.toLight": "Switch to light mode",
  "shell.brand": "Agir",
  "shell.mainNav": "Main",
  "shell.allDeals": "All deals",
  "shell.skip": "Skip to the main content",
  "shell.closed": "This workspace is closed.",
  "shell.closedBody": "It is read-only: you can open its deals, runs and reports, and change nothing.",
} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {
  "shell.toDark": "Passer au mode sombre",
  "shell.toLight": "Passer au mode clair",
  "shell.brand": "Agir",
  "shell.mainNav": "Principal",
  "shell.allDeals": "Tous les projets",
  "shell.skip": "Passer au contenu principal",
  "shell.closed": "Cet espace de travail est fermé.",
  "shell.closedBody": "Il est en lecture seule\u00a0: vous pouvez ouvrir ses projets, ses analyses et ses rapports, sans rien modifier.",
};

register(en, fr);
