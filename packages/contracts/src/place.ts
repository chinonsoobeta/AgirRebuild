// Where a deal is, and the one currency its figures are in (plan decision 7).
// Every amount prints with "$"; the deal states which dollar, once, when it is
// created. A deal that never stated it says so; nothing is inferred from its location.

export const CURRENCIES = ["CAD", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const CURRENCY_NAMES: Record<Currency, [en: string, fr: string]> = {
  CAD: ["Canadian dollars", "dollars canadiens"],
  USD: ["US dollars", "dollars américains"],
};

export const COUNTRIES = ["CA", "US"] as const;
export type Country = (typeof COUNTRIES)[number];

export const PROVINCES = [
  { code: "AB", en: "Alberta", fr: "Alberta" },
  { code: "BC", en: "British Columbia", fr: "Colombie-Britannique" },
  { code: "MB", en: "Manitoba", fr: "Manitoba" },
  { code: "NB", en: "New Brunswick", fr: "Nouveau-Brunswick" },
  { code: "NL", en: "Newfoundland and Labrador", fr: "Terre-Neuve-et-Labrador" },
  { code: "NS", en: "Nova Scotia", fr: "Nouvelle-Écosse" },
  { code: "NT", en: "Northwest Territories", fr: "Territoires du Nord-Ouest" },
  { code: "NU", en: "Nunavut", fr: "Nunavut" },
  { code: "ON", en: "Ontario", fr: "Ontario" },
  { code: "PE", en: "Prince Edward Island", fr: "Île-du-Prince-Édouard" },
  { code: "QC", en: "Quebec", fr: "Québec" },
  { code: "SK", en: "Saskatchewan", fr: "Saskatchewan" },
  { code: "YT", en: "Yukon", fr: "Yukon" },
] as const;
export type Province = (typeof PROVINCES)[number]["code"];
export const PROVINCE_CODES = PROVINCES.map((p) => p.code) as [Province, ...Province[]];

/** The location as typed, with the province added when the text does not already name it. */
export function placeLabel(location: string, province: string | null, lang: "en" | "fr" = "en"): string {
  const p = PROVINCES.find((x) => x.code === province);
  if (!p) return location;
  const word = (n: string, flags: string) => new RegExp(`(^|[^\\p{L}])${n}($|[^\\p{L}])`, flags).test(location);
  // A name in any case; a code only in capitals, so "on" or "ab" in a street name is not a province.
  if ([p.en, p.fr].some((n) => word(n, "iu")) || word(p.code, "u")) return location;
  return [location, p[lang]].filter(Boolean).join(", ");
}
