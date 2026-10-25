// Strings for the reports area. Keys start with "reports.".
import type { Entry, FrenchOf } from "./entry";

export const en = {} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {};
