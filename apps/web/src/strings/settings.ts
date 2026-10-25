// Strings for the settings area. Keys start with "settings.".
import type { Entry, FrenchOf } from "./entry";

export const en = {} satisfies Record<string, Entry>;

export const fr: FrenchOf<typeof en> = {};
