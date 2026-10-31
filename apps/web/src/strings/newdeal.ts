// Strings for the newdeal area. Keys start with "newdeal.".
import { register, type Entry, type FrenchOf } from "./entry";

export const en = {
  "newdeal.back": "All deals",
  "newdeal.lead": "Give it a name and say where it is. Then upload the documents you have, or answer a few plain questions in the quick start.",
  "newdeal.name": "Project name",
  "newdeal.nameHelp": "Shown on every report. A street name is fine.",
  "newdeal.nameBlank": "Enter a deal name",
  "newdeal.hint.Multifamily": "apartments or townhomes, 2 or more homes",
  "newdeal.hint.Mixed-use": "homes with shops or offices below",
  "newdeal.hint.Industrial": "warehouses and workshops",
  "newdeal.hint.Office": "office space",
  "newdeal.hint.Retail": "shops and restaurants",
  "newdeal.hint.Hospitality": "hotels and motels",
  "newdeal.hint.Self storage": "storage units rented by the month",
  "newdeal.hint.Other": "anything else",
  "newdeal.kind": "What kind of project is it?",
  "newdeal.locationHelp": "The city. Outside Canada, add the state.",
  "newdeal.landing": "You'll land on Documents. The quick start is there too while the deal has no documents.",
  "newdeal.cannot": "Your role cannot create deals. An owner, an admin or an analyst can.",
} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {
  "newdeal.back": "Tous les projets",
  "newdeal.lead": "Donnez-lui un nom et indiquez où il se trouve. Ensuite, téléversez les documents que vous avez, ou répondez à quelques questions simples dans le démarrage rapide.",
  "newdeal.name": "Nom du projet",
  "newdeal.nameHelp": "Affiché sur chaque rapport. Un nom de rue convient.",
  "newdeal.nameBlank": "Entrez un nom de projet",
  "newdeal.hint.Multifamily": "appartements ou maisons en rangée, 2 logements ou plus",
  "newdeal.hint.Mixed-use": "logements avec commerces ou bureaux au rez-de-chaussée",
  "newdeal.hint.Industrial": "entrepôts et ateliers",
  "newdeal.hint.Office": "bureaux",
  "newdeal.hint.Retail": "commerces et restaurants",
  "newdeal.hint.Hospitality": "hôtels et motels",
  "newdeal.hint.Self storage": "unités d'entreposage louées au mois",
  "newdeal.hint.Other": "autre chose",
  "newdeal.kind": "De quel type de projet s'agit-il ?",
  "newdeal.locationHelp": "La ville. Hors du Canada, ajoutez l'État.",
  "newdeal.landing": "Vous arriverez à l'étape Documents. Le démarrage rapide s'y trouve aussi tant que le projet n'a aucun document.",
  "newdeal.cannot": "Votre rôle ne permet pas de créer des projets. Un propriétaire, un administrateur ou un analyste le peut.",
};

register(en, fr);
