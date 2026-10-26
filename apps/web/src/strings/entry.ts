// One interface string: text, or a function of its parameters. Shared by i18n.tsx and the
// area tables in this folder, so neither imports the other.
export type Entry = string | ((p: Record<string, any>) => string | string[]);

/** The French table of an area: exactly the English table's keys, no more, no fewer. */
export type FrenchOf<T> = { [K in keyof T]: Entry };

/** The strings loaded so far, by language. i18n.tsx adds the shared table; each strings/<area>.ts adds its own when it is
 * imported, that is, when the first screen that uses it loads. */
export const loaded = { en: {} as Record<string, Entry>, fr: {} as Record<string, Entry> };

export function register(en: Record<string, Entry>, fr: Record<string, Entry>): void {
  Object.assign(loaded.en, en);
  Object.assign(loaded.fr, fr);
}
