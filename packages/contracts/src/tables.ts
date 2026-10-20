import { FIELD_BY_KEY } from "./fields.ts";
import { FR_FIELDS } from "./fr.ts";

/** Official schedules read on 2026-10-19. Proposals only: a person accepts or enters a value. */
export type Table = { id: string; title: string; publisher: string; url: string; effective: string; readOn: string; recheckBy: string; status: "official" };
const table = (id: string, title: string, publisher: string, url: string, effective: string, recheckBy = "2027-01-01"): Table =>
  ({ id, title, publisher, url, effective, readOn: "2026-10-19", recheckBy, status: "official" });
export const CMHC_PREMIUM = table("cmhc-premium", "Multi-unit Fees and Premiums", "CMHC", "https://assets.cmhc-schl.gc.ca/sites/cmhc/media-newsroom/notices/2025/cmhc-to-update-multi-unit-mortgage-loan-insurance-premiums/fees-and-premiums.pdf", "2025-07-14");
export const LAND_TABLES = {
  // the page gives no effective date; this is the date read
  BC: table("bc-land", "Property transfer tax", "Government of British Columbia", "https://www2.gov.bc.ca/gov/content/taxes/property-taxes/property-transfer-tax", "2026-10-19"),
  // the page gives no effective date; this is the date read
  MB: table("mb-land", "Land transfer tax", "Government of Manitoba", "https://gov.mb.ca/finance/other/landtransfertax.html", "2026-10-19"),
  ON: table("on-land", "Calculating land transfer tax", "Government of Ontario", "https://www.ontario.ca/document/land-transfer-tax/calculating-land-transfer-tax", "2026-04-22"),
  Toronto: table("toronto-land", "Municipal Land Transfer Tax rates and fees", "City of Toronto", "https://www.toronto.ca/services-payments/property-taxes-utilities/municipal-land-transfer-tax-mltt/municipal-land-transfer-tax-mltt-rates-and-fees/", "2026-04-01"),
  QC: table("qc-land-2026", "Droits de mutation immobilière — 2026", "Ville de Québec", "https://www.ville.quebec.qc.ca/citoyens/taxes_evaluation/droits_mutation_immobiliere.aspx", "2026-01-01"),
  // Rates remain 0.5%, 1%, 1.5%: https://www.ville.quebec.qc.ca/citoyens/taxes_evaluation/droits_mutation_immobiliere.aspx
  QC2027: table("qc-land-2027", "Montants permettant d’établir les tranches de la base d’imposition des droits sur les mutations immobilières – Exercice 2027", "Gouvernement du Québec, Affaires municipales et Habitation", "https://www.quebec.ca/nouvelles/actualites/details/montants-permettant-detablir-les-tranches-de-la-base-dimposition-des-droits-sur-les-mutations-immobilieres-exercice-2027-72131", "2027-01-01", "2028-01-01"),
  Montreal: table("montreal-land", "Droits sur les mutations immobilières", "Ville de Montréal", "https://montreal.ca/articles/comment-sont-calcules-les-droits-sur-les-mutations-immobilieres-9279", "2026-01-12"),
  NS: table("ns-land", "Deed Transfer Tax Rates — July 2026", "Service Nova Scotia", "https://novascotia.ca/sns/pdf/ans-property-dtt-rates.pdf", "2026-07-01"),
  NB: table("nb-land", "Real Property Transfer Tax Act", "Government of New Brunswick", "https://laws.gnb.ca/en/document/cs/R-2.1", "2016-04-01"),
  PE: table("pe-land", "Real Property Transfer Tax Act", "Government of Prince Edward Island", "https://www.princeedwardisland.ca/sites/default/files/legislation/r-05-1-real_property_transfer_tax_act.pdf", "2026-05-29"),
  AB: table("ab-land", "Land Titles fee schedule", "Government of Alberta", "https://www.alberta.ca/system/files/sartr-land-titles-and-surveys-common-documents-fee-schedule.pdf", "2026-10-01"),
  NL: table("nl-land", "Registry of Deeds fees", "Government of Newfoundland and Labrador", "https://www.gov.nl.ca/gs/files/forms-files-fees-deed.pdf", "2007-05-01"),
  SK: table("sk-land", "Land Titles Fees", "Saskatchewan Registry Services", "https://www.saskregistries.ca/hubfs/Land-Title-Fees-Table-04-2026.pdf", "2026-04-15"),
} as const;
export const GST_HST = table("gst-hst-pbrh", "Purpose-built rental housing rebate", "Canada Revenue Agency", "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/gst-hst-rebates/purpose-built-rental-housing.html", "2026-06-21");
export const TABLES: readonly Table[] = [CMHC_PREMIUM, ...Object.values(LAND_TABLES), GST_HST];
export const tableCurrent = (t: Table, asOf: string): boolean => asOf >= t.effective && asOf < t.recheckBy;
const expired = { unavailable: "The table is not effective yet or is past its re-check date; enter the value yourself." };
export type Proposal = { fieldKey: string; tableId: string; title: string; publisher: string; url: string; effective: string; options: { key: string; label: string; value: number; reason: string }[]; unavailable?: string };
export type TableOption = { key: string; label: string; value: number; note?: string };
type Options = { options: TableOption[] } | { unavailable: string };

export function cmhcPremium({ ltvPct, amortYears, points, asOf }: { ltvPct: number; amortYears: number; points?: number; asOf: string }): { value: number; label: string } | { unavailable: string } {
  if (!tableCurrent(CMHC_PREMIUM, asOf)) return expired;
  const select = (points ?? 0) >= 50;
  if (ltvPct > 95 || (!select && ltvPct > 85)) return { unavailable: "The loan-to-value is outside this product's premium table; enter the premium yourself." };
  if (amortYears > 25 && (amortYears - 25) % 5 !== 0) return { unavailable: "the table charges per five-year period; enter the premium yourself" };
  const base = ltvPct <= 65 ? 260 : ltvPct <= 70 ? 285 : ltvPct <= 75 ? 335 : ltvPct <= 80 ? 435 : ltvPct <= 85 ? 535 : ltvPct <= 90 ? 590 : 615;
  const premium = base + Math.max(0, (amortYears - 25) / 5) * 25;
  const discount = (points ?? 0) >= 100 ? 30 : (points ?? 0) >= 70 ? 20 : select ? 10 : 0;
  return { value: Math.round(premium * (100 - discount) / 100) / 100, label: select ? `CMHC MLI Select, ${points} points` : "CMHC MLI Standard" };
}

// Cents times hundredths of a percent; sum before rounding once at the end.
type Brackets = readonly (readonly [number, number])[];
const marginal = (cents: number, brackets: Brackets): number => {
  let lower = 0, numerator = 0;
  for (const [upperDollars, rate] of brackets) {
    const upper = upperDollars * 100;
    numerator += Math.max(0, Math.min(cents, upper) - lower) * rate;
    lower = upper;
  }
  return numerator;
};
const ON: Brackets = [[55000,50],[250000,100],[400000,150],[Infinity,200]];
const ON_HOMES: Brackets = [[55000,50],[250000,100],[400000,150],[2000000,200],[Infinity,250]];
const TORONTO_HOMES: Brackets = [[55000,50],[250000,100],[400000,150],[2000000,200],[3000000,250],[4000000,440],[5000000,545],[10000000,650],[20000000,755],[Infinity,860]];
const NS_RATES: readonly (readonly [string, number])[] = [["Municipality of the County of Annapolis", 150], ["Town of Annapolis Royal", 150], ["Town of Middleton", 150], ["Municipality of the County of Antigonish", 100], ["Town of Antigonish", 150], ["Cape Breton Regional Municipality", 150], ["Municipality of Colchester", 150], ["Town of Stewiacke", 100], ["Town of Truro", 150], ["Municipality of the County of Cumberland", 150], ["Town of Amherst", 150], ["Town of Oxford", 150], ["Municipality of the District of Clare", 100], ["Municipality of the District of Digby", 100], ["Town of Digby", 150], ["Municipality of the District of Guysborough", 100], ["Municipality of the District of St. Mary's", 125], ["Town of Mulgrave", 150], ["Halifax Regional Municipality", 150], ["Municipality of the District of Hants East", 150], ["West Hants Regional Municipality", 150], ["Municipality of the County of Inverness", 150], ["Town of Port Hawkesbury", 150], ["Municipality of the County of Kings", 150], ["Town of Berwick", 125], ["Town of Kentville", 150], ["Town of Wolfville", 150], ["Municipality of the District of Chester", 150], ["Municipality of the District of Lunenburg", 125], ["Town of Bridgewater", 150], ["Town of Lunenburg", 150], ["Town of Mahone Bay", 150], ["Municipality of the County of Pictou", 100], ["Town of New Glasgow", 100], ["Town of Pictou", 100], ["Town of Stellarton", 100], ["Town of Trenton", 100], ["Town of Westville", 100], ["Region of Queens Municipality", 150], ["Municipality of the County of Richmond", 150], ["Municipality of the District of Barrington", 150], ["Municipality of the District of Shelburne", 150], ["Town of Clark's Harbour", 100], ["Town of Lockeport", 150], ["Town of Shelburne", 150], ["Municipality of the County of Victoria", 150], ["Municipality of the District of Argyle", 100], ["Municipality of the District of Yarmouth", 100], ["Town of Yarmouth", 100]];
export function landTable(province: string, asOf: string): Table | undefined {
  if (province === "QC") return asOf >= LAND_TABLES.QC2027.effective ? LAND_TABLES.QC2027 : LAND_TABLES.QC;
  return LAND_TABLES[province as keyof typeof LAND_TABLES];
}
export function landTransferTaxOptions({ province, value, asOf }: { province: string; value: number; asOf: string }): Options {
  const t = landTable(province, asOf);
  if (!t) return { unavailable: "no verified public table; enter the amount" };
  if (!tableCurrent(t, asOf)) return expired;
  const cents = Math.round(value * 100);
  const option = (key: string, label: string, numerator: number, note?: string): TableOption => ({ key, label, value: Math.round(numerator / 10000) / 100, ...(note ? { note } : {}) });
  const tax = (key: string, label: string, b: Brackets, note?: string) => option(key,label,marginal(cents,b),note);
  let options: TableOption[];
  switch (province) {
    case "BC":
      if (value > 3000000) return { unavailable: "The further 2% above $3,000,000 and its rental exemption need a person; enter the amount." };
      options = [tax("bc","British Columbia",[[200000,100],[2000000,200],[Infinity,300]],"Tax is on fair market value; the land cost stands in for it. The source page gives no date.")]; break;
    case "MB": options = [tax("mb","Manitoba",[[30000,0],[90000,50],[150000,100],[200000,150],[Infinity,200]])]; break;
    case "ON": {
      if (!tableCurrent(LAND_TABLES.Toronto,asOf)) return expired;
      const note = "Toronto's administration fee ($102.56 + HST) belongs in soft costs.";
      options = [tax("on","Ontario, outside Toronto",ON),tax("on-homes","Ontario, outside Toronto, land with one or two single-family homes",ON_HOMES),
        option("toronto","Toronto",marginal(cents,ON)*2,note),option("toronto-homes","Toronto, land with one or two single-family homes",marginal(cents,ON_HOMES)+marginal(cents,TORONTO_HOMES),note)]; break;
    }
    case "QC": {
      const future = t === LAND_TABLES.QC2027;
      options = [tax("qc","Most municipalities",[[future?64400:62900,50],[future?322600:315000,100],[Infinity,150]],"A municipality may charge up to 3% above $500,000.")];
      if (!future) {
        if (!tableCurrent(LAND_TABLES.Montreal,asOf)) return expired;
        options.push(tax("quebec-city","Ville de Québec 2026",[[62900,50],[315000,100],[500000,150],[750000,250],[Infinity,300]]),tax("montreal","Montréal 2026",[[62900,50],[315000,100],[552300,150],[1104700,200],[2136500,250],[3113000,350],[Infinity,400]]));
      }
      break;
    }
    case "NS": options = NS_RATES.map(([label,rate],i)=>option(`ns-${i}`,label,cents*rate)); break;
    case "NB": case "PE": {
      const note = "1% of the greater of the price and the assessed value; the land cost stands in for both. Use the assessed value if it is higher.";
      options = [option(province.toLowerCase(),province === "NB" ? "New Brunswick" : "Prince Edward Island",cents*100,note)];
      if (province === "NB") options[0]!.value = Math.floor((cents*100 + 500000) / 1000000);
      break;
    }
    default: options = [option(province.toLowerCase(),province,0,"No land transfer tax; land titles / registry fees belong in soft costs." + (province === "SK" ? " (Saskatchewan title transfer fee: 0.4% of the whole value once it exceeds $6,300, Land Titles Fees effective 2026-04-15, https://www.saskregistries.ca/hubfs/Land-Title-Fees-Table-04-2026.pdf)" : ""))];
  }
  return { options };
}
export function gstHstNetOptions({ province, units, selling, asOf }: { province: string; units: number; selling: boolean; asOf: string }): Options {
  if (!tableCurrent(GST_HST,asOf)) return expired;
  if (selling || units < 4) return { unavailable: "the purpose-built rental rebate needs 4+ rental units; the NRRP rebate is entered by a person" };
  // Revenu Québec, GST/QST New Residential Rental Property Rebate for Businesses and
  // GST Rebate for Purpose-Built Multiple Unit Residential Rental Complexes; read 2026-10-19:
  // https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/special-cases-gsthst-and-qst/purchase-sale-construction-renovation-and-operation-of-real-property/refunds-of-taxes-paid/gstqst-new-residential-rental-property-rebate-for-businesses/
  // https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/special-cases-gsthst-and-qst/purchase-sale-construction-renovation-and-operation-of-real-property/refunds-of-taxes-paid/gst-rebate-for-purpose-built-multiple-unit-residential-rental-complexes/
  if (province === "QC") return { unavailable: "Quebec has no full QST rebate for purpose-built rentals (the full rebate covers GST only). QST of 9.975% on the fair market value at completion is payable, less a rebate of up to $7,182 per unit that is nil at $225,000 or more per unit. Enter the net amount." };
  if (!["AB","BC","MB","SK","ON","NS","NL","NT","NU","YT","NB","PE"].includes(province)) return { unavailable: "no verified public table; enter the amount" };
  const note = "At least 4 units each with its own kitchen, bathroom and living area; at least 90% held for long-term rental; construction begins after 2023-09-13 and before 2031; substantial completion before 2036."
    + (province === "NB" ? " Provincial part only if construction begins after 2024-11-14 and before 2028 and completes before 2030." : "")
    + (province === "PE" ? " Provincial part is rebated up to $35,000 per unit only for completion before 2029." : "");
  return { options: [{key:"pbrh",label:"Qualifying purpose-built rental rebate",value:0,note}] };
}

/** The source snapshot belongs to the accepted value, even when a later table is re-dated. */
export type TableSource = { tableId: string; optionKey: string; publisher: string; title: string; effective: string; fields: string[]; acceptedBy: string };
export function tableSourceLabel(s: TableSource, lang: "en" | "fr" = "en"): string {
  const fields=s.fields.map(key=>lang === "fr" ? FR_FIELDS[key] ?? FIELD_BY_KEY.get(key)?.label ?? key : FIELD_BY_KEY.get(key)?.label ?? key).join(", ");
  const label=lang === "fr" ? `Tableau publié : ${s.publisher}, en vigueur le ${s.effective} · accepté par ${s.acceptedBy}` : `Published table: ${s.publisher}, effective ${s.effective} · accepted by ${s.acceptedBy}`;
  return label + (fields ? lang === "fr" ? ` · selon les valeurs déclarées : ${fields}` : ` · uses stated: ${fields}` : "");
}
