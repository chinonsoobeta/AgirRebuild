// Strings for the compare area. Keys start with "compare.".
import type { Entry, FrenchOf } from "./entry";

export const en = {} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {};
