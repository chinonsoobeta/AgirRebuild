import { describe, expect, it } from "vitest";
import { TABLES, tableCurrent, cmhcPremium, landTransferTaxOptions, gstHstNetOptions, premiumTaxOptions, pbrhExplanation } from "../src/tables.ts";

const asOf = "2026-10-20";
function land(province: string, value: number, date = asOf) {
  const result = landTransferTaxOptions({ province, value, asOf: date });
  expect(result).toHaveProperty("options");
  if (!("options" in result)) throw new Error(result.unavailable);
  return result.options;
}
describe("card 94a cited tables", () => {
  it.each([[85,40,50,5.49],[80,45,70,4.28],[92,50,100,5.18],[75,25,undefined,3.35]])("premium %s / %s / %s", (ltvPct, amortYears, points, value) => {
    expect(cmhcPremium({ ltvPct: ltvPct!, amortYears: amortYears!, points, asOf })).toMatchObject({ value });
  });
  it.each([[88,40,undefined],[85,27,undefined],[96,40,100]])("unavailable premium %s / %s", (ltvPct, amortYears, points) => {
    expect(cmhcPremium({ ltvPct: ltvPct!, amortYears: amortYears!, points, asOf })).toHaveProperty("unavailable");
  });
  it("Ontario and Toronto, including the municipal homes tiers", () => {
    expect(land("ON",1_000_000).map(x => x.value)).toEqual([16475,16475,32950,32950]);
    expect(land("ON",500_000)[0]!.value).toBe(6475);
    expect(land("ON",2_500_000).map(x => x.value)).toEqual([46475,48975,92950,97950]);
    const large = land("ON",4_500_000);
    expect(large[3]!.value-large[1]!.value).toBe(132725);
  });
  it.each([["BC",1_000_000,18000],["BC",2_500_000,53000],["MB",500_000,7650],["NB",750_000,7500],["NB",123450,1235],["PE",750_000,7500],["SK",750_000,3000],["AB",750_000,800],["NL",750_000,3098]])("%s land %s", (province,value,expected) => {
    expect(land(province as string,value as number)[0]!.value).toBe(expected);
  });
  it("Quebec published annual thresholds and municipal options", () => {
    expect(land("QC",500_000)[0]!.value).toBe(5610.50);
    expect(land("QC",500_000,"2027-01-05")[0]!.value).toBe(5565);
    expect(land("QC",800_000)[1]!.value).toBe(13360.50);
    expect(land("QC",700_000)[2]!.value).toBe(9349);
  });
  it("offers all 49 NS municipalities without inferring a location", () => {
    const options = land("NS",750_000);
    expect(options).toHaveLength(49);
    expect(options.find(x=>x.label === "Halifax Regional Municipality")!.value).toBe(11250);
    expect(new Set(options.map(x=>x.key)).size).toBe(49);
  });
  it("explains assessed value, registry fees, and the BC limit", () => {
    for (const p of ["NB","PE"]) expect(land(p,750_000)[0]!.note).toContain("Use the assessed value if it is higher");
    expect(land("SK",750_000)[0]!.note).toBe("Mortgage registration fees belong in soft costs.");
    expect(land("SK",750_000)[0]!.note).toContain("soft costs");
    expect(landTransferTaxOptions({province:"BC",value:3000001,asOf})).toHaveProperty("unavailable");
    for (const province of ["NT","NU","YT"]) expect(landTransferTaxOptions({province,value:750000,asOf})).toHaveProperty("unavailable");
  });
  it.each(["AB","BC","MB","SK","ON","NS","NL","NT","NU","YT","NB","PE"])("rental rebate %s", province => {
    expect(gstHstNetOptions({province,units:4,selling:false,asOf})).toMatchObject({ options:[{value:0}] });
  });
  it("requires a person for sales, fewer than four units and QST; discloses rebate conditions", () => {
    for (const args of [{province:"ON",units:3,selling:false},{province:"ON",units:4,selling:true},{province:"QC",units:4,selling:false}]) expect(gstHstNetOptions({...args,asOf})).toHaveProperty("unavailable");
    expect(gstHstNetOptions({province:"QC",units:4,selling:false,asOf})).toEqual({ unavailable: "Quebec has no full QST rebate for purpose-built rentals (the full rebate covers GST only). QST of 9.975% on the fair market value at completion is payable, less a rebate of up to $7,182 per unit that is nil at $225,000 or more per unit. Enter the net amount." });
    const nb=gstHstNetOptions({province:"NB",units:4,selling:false,asOf});
    const pe=gstHstNetOptions({province:"PE",units:4,selling:false,asOf});
    expect(JSON.stringify(nb)).toContain("2024-11-14");
    expect(JSON.stringify(pe)).toContain("35,000");
    expect(JSON.stringify(nb)).toContain("90%");
  });
  it("expires all 2026 tables and refuses pre-effective dates", () => {
    for (const t of TABLES.filter(t=>t.effective < "2027-01-01")) {
      expect(tableCurrent(t,t.recheckBy)).toBe(false);
      expect(tableCurrent(t,"1900-01-01")).toBe(false);
    }
    expect(cmhcPremium({ltvPct:85,amortYears:40,asOf:"2027-08-01"})).toMatchObject({unavailable:expect.stringContaining("past its re-check date")});
    for (const province of ["BC","MB","ON","NS","NB","PE","AB","NL","SK"]) expect(landTransferTaxOptions({province,value:500000,asOf:"2027-08-01"})).toMatchObject({unavailable:expect.stringContaining("past its re-check date")});
    expect(gstHstNetOptions({province:"ON",units:4,selling:false,asOf:"2027-08-01"})).toMatchObject({unavailable:expect.stringContaining("past its re-check date")});
  });
  it("uses the read date where BC and Manitoba give no effective date", () => {
    for (const id of ["bc-land","mb-land"]) expect(TABLES.find(t=>t.id === id)!.effective).toBe("2026-10-19");
  });
  it("records official source metadata", () => {
    for (const t of TABLES) {
      expect(t.url).toMatch(/^https:\/\//);
      expect(t.status).toBe("official");
      expect(t.readOn).toBe("2026-10-24");
      expect(t.readOn < t.recheckBy).toBe(true);
      expect(t.effective < t.recheckBy).toBe(true);
    }
  });
});


describe("card 125: document taxes require verification", () => {
  it("flags only the two taxes, in English and French", async () => {
    const { FIELDS, FR_VERIFY } = await import("../src/index.ts");
    expect(FIELDS.filter(f => f.verify).map(f => f.key).sort()).toEqual(["gst_hst_net", "property_tax_annual"]);
    expect(FIELDS.find(f => f.key === "gst_hst_net")).toMatchObject({ extractable: true, verify: "Check this: GST/HST net depends on the rebates this project qualifies for." });
    expect(FIELDS.find(f => f.key === "property_tax_annual")).toMatchObject({ extractable: true, verify: "Check this is not already inside your operating costs or expense ratio." });
    expect(FR_VERIFY).toEqual({ gst_hst_net: "À vérifier : la TPS/TVH nette dépend des remboursements auxquels ce projet a droit.", property_tax_annual: "Vérifiez qu'elle n'est pas déjà comprise dans vos charges d'exploitation ou votre ratio des charges." });
  });
});


describe("card 152 owner-signed tables for invented rentals", () => {
  it("records each signed row and its individual re-check date", () => {
    const dates: Record<string,string> = {
      "cmhc-premium":"2027-01-31", "toronto-land":"2027-04-01", "ns-land":"2027-07-31",
      ...Object.fromEntries(["bc-land","mb-land","on-land","nb-land","pe-land","ab-land","nl-land","sk-land","gst-hst-pbrh","on-premium-tax","sk-premium-tax"].map(id=>[id,"2027-04-30"])),
      ...Object.fromEntries(["qc-land-2026","qc-land-2027","montreal-land","qc-premium-tax"].map(id=>[id,"2027-01-15"])),
    };
    expect(TABLES.map(t=>t.id).sort()).toEqual(Object.keys(dates).sort());
    for (const t of TABLES) {
      expect(t).toMatchObject({readOn:"2026-10-24",signedOn:"2026-10-24",recheckBy:dates[t.id]});
      expect(tableCurrent(t,t.recheckBy)).toBe(false);
    }
  });
  it.each([
    ["AB",1000000,1050],["AB",1000001,1055],["AB",5000,55],["AB",5000.01,60],
    ["SK",1000000,4000],["SK",500,0],["SK",500.01,25],["SK",6300,25],["SK",6300.01,25.20],
    ["NL",1000000,4098],["NL",1000001,4098.40],["NL",500,100],["NL",500.01,100.40],
  ])("%s invented land cost %s gives %s", (province,value,expected) => {
    const options=land(province as string,value as number,"2026-10-24");
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({key:(province as string).toLowerCase(),value:expected,note:"Mortgage registration fees belong in soft costs."});
  });
  it.each(["2027-04-01","2027-04-02","2027-04-29"])("offers only outside Toronto on %s", date => {
    expect(land("ON",1000000,date).map(o=>o.key)).toEqual(["on","on-homes"]);
  });
  it("refuses 50–69 points above 85% and retains the 70 point price", () => {
    for (const points of [50,69]) expect(cmhcPremium({points,ltvPct:90,amortYears:40,asOf})).toEqual({unavailable:"MLI Select at 50 points lends up to 85% loan-to-value; enter the premium yourself."});
    expect(cmhcPremium({points:70,ltvPct:95,amortYears:45,asOf})).toMatchObject({value:5.72});
  });
  it.each([["ON",[8]],["SK",[6]],["QC",[9,9.975]]] as const)("offers %s premium taxes", (province,values) => {
    const result=premiumTaxOptions({province,asOf:"2026-10-24"});
    expect("options" in result && result.options.map(o=>o.value)).toEqual(values);
    expect(premiumTaxOptions({province,asOf:"2027-05-01"})).toHaveProperty("unavailable");
  });
  it("requires a typed premium tax elsewhere", () => {
    expect(premiumTaxOptions({province:"BC",asOf})).toEqual({unavailable:"no verified public table; enter the rate (0 if none)"});
  });
  it.each(["en","fr"] as const)("explains the rebate in %s with optional read date", lang => {
    const noDate=pbrhExplanation(undefined,lang), dated=pbrhExplanation("2026-10-24",lang);
    expect(noDate).toContain(lang === "en" ? "GST/HST net is $0" : "TPS/TVH nette de 0 $");
    expect(noDate).toContain(lang === "en" ? "at least 10 private rooms or suites" : "au moins 10 chambres ou suites privées");
    expect(noDate).toContain("2023-09-13"); expect(noDate).toContain("2036");
    expect(noDate).not.toMatch(/undefined|read |consulté le/);
    expect(dated).toBe(noDate.slice(0,-1)+(lang === "en" ? ", read " : ", consulté le ")+"2026-10-24.");
    expect(gstHstNetOptions({province:"ON",units:12,selling:false,asOf})).toMatchObject({options:[{label:"Appears to qualify for the purpose-built rental rebate",value:0,note:expect.stringContaining("living area or at least 10 private rooms or suites")}]});
  });
});
