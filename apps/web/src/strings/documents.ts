// Strings for the documents area. Keys start with "documents.".
import type { Entry, FrenchOf } from "./entry";

export const en = {} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {};
