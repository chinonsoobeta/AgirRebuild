// Strings for the agirreview area. Keys start with "agirreview.".
import type { Entry, FrenchOf } from "./entry";

export const en = {} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {};
