// One interface string: text, or a function of its parameters. Shared by i18n.tsx and the
// area tables in this folder, so neither imports the other.
export type Entry = string | ((p: Record<string, any>) => string | string[]);

/** The French table of an area: exactly the English table's keys, no more, no fewer. */
export type FrenchOf<T> = { [K in keyof T]: Entry };
