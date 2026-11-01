import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { parseDocument, extractCandidates, addressedText, columnName } from "../src/index.ts";
import { blankResults } from "../src/parse.ts";

type V = string | number | null | { f: string; r: number | string };
const F = (r: number | string, f = "1+1"): V => ({ f, r });
async function book(sheets: Record<string, { rows: V[][]; merge?: string[] }>) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  for (const [name, s] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    s.rows.forEach((row, r) => row.forEach((v, c) => {
      if (v === null) return;
      const cell = ws.getCell(r + 1, c + 1);
      if (typeof v === "object") cell.value = { formula: v.f, result: v.r } as never;
      else cell.value = v;
    }));
    for (const m of s.merge ?? []) ws.mergeCells(m);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
const C = "Worked out by a formula", Z = "A zero beside another figure", L = "Another figure in this", N = "No field matches this", B = "No budget line matches", P = "Other lines beside it", K = "Looks like land cost", H = "Another line of this cost", S = "Not shown to add up";
type Reading = [string, number, string, string?];
type Listed = [number, string, string];
type Case = { id: number; rows: V[][]; reads?: Reading[]; listed?: Listed[]; sheet?: string; merge?: string[] };
const read = (key: string, value: number, cell: string, item?: string): Reading => item ? [key, value, cell, item] : [key, value, cell];
const many = (n: number, value: number) => Array<V>(n).fill(value);
const cases: Case[] = [
 {id:1,rows:[["Land cost",1000000,F(2000000)]],reads:[read("land_cost",1000000,"B1")]},
 {id:2,rows:[["Land cost",F(572409),1000000]],reads:[read("land_cost",1000000,"C1")]},
 {id:3,rows:[["Land cost",F(1000000)]],listed:[[1000000,"B1",C]]},
 {id:4,rows:[["Widgets",F(1000000)]]},
 {id:5,rows:[["Senior loan",F(7500000),"75%"]],listed:[[75,"C1","The figure is outside"]]},
 {id:6,rows:[["Land cost",F(1000000),0]],listed:[[0,"C1",Z]]},
 {id:7,rows:[["Land cost",0,F(1000000)]],listed:[[0,"B1",Z]]},
 {id:8,rows:[["Land cost",0]],listed:[[0,"B1",K]]},
 {id:9,rows:[["Land cost",F(0)]]},
 {id:10,rows:[[F("The total project cost is $5,000,000 for this building.","A1")],["The land cost is $1,000,000 for this building site."]],reads:[read("land_cost",1000000,"A2")]},
 {id:11,rows:[["Lease-up ramp",F("Yes")]]},
 {id:12,rows:[["Lease-up ramp","Yes"]],reads:[read("lease_up_ramp",1,"B1")]},
 {id:13,rows:[["S-curve draws","No"],["Lease-up ramp",F("Yes")]],reads:[read("s_curve_draws",0,"B1")]},
 {id:14,rows:[[8,"Land cost"],[9,"Hard costs"],[10,"Senior loan",F(2000000)],[11,"Soft costs",F(1000)],[12,"Contingency",F(1000)],[13,"Interest rate",F(5)]],listed:[[2000000,"C3",C],[1000,"C4",C],[1000,"C5",C]]},
 {id:15,rows:[["Land cost",F("1,000,000")],["Hard costs","2,000,000"]],reads:[read("hard_cost",2000000,"B2")],listed:[[1000000,"B1",C]]},
 {id:16,rows:[["Studio",F("10 homes"),F("$1,500 rent")]],listed:[[10,"B1",C]]},
 {id:17,rows:[["Studio","10 homes","$1,500 rent"]],reads:[read("unit_count",10,"B1","Studio")],listed:[[1500,"C1",L]]},
 {id:18,rows:[[F(1000000),"Land cost"],[F(2000000),"Hard costs"],[F(100000),"Contingency"]],listed:[[1000000,"A1",C],[2000000,"A2",C],[100000,"A3",C]]},
 {id:19,rows:[[1000000,"Land cost"],[2000000,"Hard costs"],[100000,"Contingency"]],reads:[read("land_cost",1000000,"A1"),read("hard_cost",2000000,"A2"),read("contingency",100000,"A3")]},
 {id:20,rows:[[F("The land cost is $1,000,000 for the whole site")]]},
 {id:21,rows:[["The land cost is $1,000,000 for the whole site"]],reads:[read("land_cost",1000000,"A1")]},
 {id:22,sheet:"Budget",rows:[["Item","Amount"],["Framing",100000],["Mechanical",200000],["Total hard costs",F(300000)],["Legal",5000],["Audit",7000],["Total soft costs",12000]],reads:[read("soft_cost",12000,"B5, Budget!B6")],listed:[[200000,"B3",B],[300000,"B4",C],[100000,"B2",P],[7000,"B6",B]]},
 {id:23,sheet:"Budget",rows:[["Item","Amount"],["Land",1000000],["Hard costs",5000000],["Total project cost",F(6000000)]],reads:[read("land_cost",1000000,"B2"),read("hard_cost",5000000,"B3")],listed:[[6000000,"B4",C]]},
 {id:24,sheet:"Budget",rows:[["Item","Amount"],["Land",100000],["Hard costs",200000],["Contingency",F(10000)]],reads:[read("land_cost",100000,"B2"),read("hard_cost",200000,"B3")],listed:[[10000,"B4",C]]},
 {id:25,sheet:"Rent roll",rows:[["Unit type","Units","Monthly rent"],["1BR",4,F(1200)],["2BR",2,F(1500)]],reads:[read("unit_count",4,"B2","1BR"),read("unit_count",2,"B3","2BR")],listed:[[1200,"C2",C],[1500,"C3",C]]},
 {id:26,sheet:"Rent roll",rows:[["Unit type","Units","Rent"],["1-bed",F(10),F(1500)],["2-bed",F(5),F(1900)]],listed:[[10,"B2",C],[1500,"C2",C],[5,"B3",C],[1900,"C3",C]]},
 {id:27,sheet:"Rent roll",rows:[["Unit type","Units","Rent"],["1-bed",10,1500],["2-bed",5,1900]],reads:[read("unit_count",10,"B2","1BR"),read("unit_rent_monthly",1500,"C2","1BR"),read("unit_count",5,"B3","2BR"),read("unit_rent_monthly",1900,"C3","2BR")]},
 {id:28,rows:[["Land cost",1000000,1000000,1000000]],merge:["B1:D1"],reads:[read("land_cost",1000000,"B1")]},
 {id:29,rows:[["Hard costs","Hard costs",5000000]],merge:["A1:B1"],reads:[read("hard_cost",5000000,"C1")]},
 {id:30,rows:[["Land cost",1000000],["Land cost",2000000]],merge:["A1:A2"],reads:[read("land_cost",1000000,"B1"),read("land_cost",2000000,"B2")]},
 {id:31,rows:[["Land cost","Land cost",1000000],["Land cost","Land cost",2000000]],merge:["A1:B2"],reads:[read("land_cost",1000000,"C1"),read("land_cost",2000000,"C2")]},
 ...[5,4].map((n): Case => ({id:n===5?32:33,rows:Array.from({length:n},(_,i)=>[i===2?"Construction months":`Line ${i+1}`,i===2?18:null,null,null,i+1]),reads:[read("construction_months",18,"B3")],listed:n===5?[]:[[1,"E1",N],[2,"E2",N],[3,"E3",L],[4,"E4",N]]})),
 {id:34,rows:["Land cost","Hard costs","Soft costs","Contingency","Senior loan","Equity"].map((label,i)=>[i+1,label,1000*(i+2)]),reads:["land_cost","hard_cost","soft_cost","contingency","senior_loan_amount","equity_amount"].map((k,i)=>read(k,1000*(i+2),`C${i+1}`))},
 {id:35,rows:Array.from({length:6},(_,i)=>["Line",null,i<3?i+1:900+i])},
 {id:36,rows:Array.from({length:7},(_,i)=>["Land cost",i<3?i+1:900+i]),listed:Array.from({length:7},(_,i)=>[i<3?i+1:900+i,`B${i+1}`,K])},
 {id:37,rows:[["Rental income",...Array.from({length:10},(_,i)=>1000000+i*1000)]],listed:Array.from({length:10},(_,i)=>[1000000+i*1000,`${columnName(i+1)}1`,N])},
 {id:38,rows:[["Land cost",...many(12,1000)],["Hard costs",...many(13,2000)]],reads:[read("land_cost",1000,"B1")],listed:Array.from({length:11},(_,i)=>[1000,`${columnName(i+2)}1`,L])},
 {id:39,rows:[["Land cost",1000000],["Senior loan",5000000],[],["Month",...Array.from({length:14},(_,i)=>i+1)],["Hard cost draw",...Array.from({length:14},()=>F(100000))],["Interest",...Array.from({length:14},()=>F(5000))]],reads:[read("land_cost",1000000,"B1"),read("senior_loan_amount",5000000,"B2")]},
 {id:40,rows:[["Month",...Array.from({length:14},(_,i)=>i+1)],["Hard cost draw",...many(14,100000)],["Opening zero",0,...many(13,100000)]]},
 {id:41,rows:[["Hard costs",...many(12,1000)]],reads:[read("hard_cost",1000,"B1")],listed:Array.from({length:11},(_,i)=>[1000,`${columnName(i+2)}1`,L])},
 // A formula line stops the typed lines of its field being added up: a partial sum is never a reading, and a printed total reads alone.
 {id:60,sheet:"Budget",rows:[["Hard costs","Framing",1000],["Hard costs","Mechanical",F(2000)],["Hard costs","Drywall",500]],listed:[[2000,"C2",C],[1000,"C1",H],[500,"C3",H]]},
 {id:61,sheet:"Budget",rows:[["Hard costs","Framing",1000],["Hard costs","Mechanical",2000],["Hard costs","Drywall",500]],reads:[read("hard_cost",3500,"C1, Budget!C2, Budget!C3")]},
 {id:62,sheet:"Budget",rows:[["Hard costs","Framing",1000],["Hard costs","Mechanical",F(2000)],["Hard costs","Drywall",500],["Hard costs","Total hard costs",3500]],reads:[read("hard_cost",3500,"C4")],listed:[[2000,"C2",C],[1000,"C1",H],[500,"C3",H]]},
 {id:63,sheet:"Budget",rows:[["Item","Amount"],["Hard cost - building",100000],["Hard cost - sitework",F(200000)]],listed:[[200000,"B3",C],[100000,"B2",H]]},
 {id:64,sheet:"Budget",rows:[["Item","Amount"],["Alpha widget",100000],["Beta widget",F(200000)],["Total hard costs",300000]],reads:[read("hard_cost",300000,"B4")],listed:[[100000,"B2",S]]},
 {id:65,sheet:"Budget",rows:[["Item","Amount"],["Hard cost - building",100000],["Beta widget",F(200000)],["Total hard costs",300000]],reads:[read("hard_cost",300000,"B4")],listed:[[100000,"B2",S]]},
 {id:66,sheet:"Budget",rows:[["Item","Amount"],["Land",100000],["Hard cost - building",200000],["Soft cost - legal",F(5000)]],reads:[read("land_cost",100000,"B2"),read("hard_cost",200000,"B3")],listed:[[5000,"B4",C]]},
 {id:67,rows:[["Alpha widget",100000],["Beta widget",F(200000)],["Total hard costs",300000]],reads:[read("hard_cost",300000,"B3")],listed:[[100000,"B1",N]]},
 {id:68,rows:[["Alpha widget",100000],["Beta widget",...many(13,1000)],["Total hard costs",300000]],reads:[read("hard_cost",300000,"B3")],listed:[[100000,"B1",N]]},
 // What a formula line has made partial ends with its run.
 {id:69,sheet:"Budget",rows:[["Item","Amount"],["Beta widget",F(200000)],["Land",100000],["Alpha widget",50000],["Total soft costs",50000]],reads:[read("land_cost",100000,"B3"),read("soft_cost",50000,"B4")],listed:[[50000,"B4",B]]},
 {id:70,sheet:"Budget",rows:[["Item","Amount"],["Beta widget",F(200000)],["Total hard costs",F(200000)],["Alpha widget",50000],["Total soft costs",50000]],reads:[read("soft_cost",50000,"B4")],listed:[[200000,"B3",C],[50000,"B4",B]]},
 {id:71,sheet:"Budget",rows:[["Item","Amount"],["Beta widget",F(200000)],["Total hard costs",200000],["Alpha widget",50000],["Total soft costs",50000]],reads:[read("hard_cost",200000,"B3"),read("soft_cost",50000,"B4")],listed:[[50000,"B4",B]]},
 {id:72,rows:[["Beta widget",F(200000)],["Total hard costs",200000],["Alpha widget",50000],["Gamma widget",60000],["Total soft costs",200000]],reads:[read("hard_cost",200000,"B2"),read("soft_cost",200000,"B5"),read("soft_cost",110000,"B3, Inputs!B4")],listed:[[50000,"B3",N],[60000,"B4",N]]},
 // A computed total is no line: the typed lines above it still add up.
 {id:93,sheet:"Budget",rows:[["Item","Amount"],["Hard cost - building",100000],["Hard cost - sitework",200000],["Total hard costs",F(300000)]],reads:[read("hard_cost",300000,"B2, Budget!B3")],listed:[[300000,"B4",C]]},
 // A total of either kind ends the lines above it.
 {id:73,rows:[["Alpha widget",100000],["Beta widget",200000],["Total soft costs",...many(13,1000)],["Gamma widget",50000],["Total hard costs",50000]],reads:[read("hard_cost",50000,"B5")],listed:[[100000,"B1",N],[200000,"B2",N],[50000,"B4",N]]},
 {id:74,rows:[["Alpha widget",100000],["Beta widget",200000],["Total soft costs",F(300000)],["Gamma widget",50000],["Total hard costs",50000]],reads:[read("hard_cost",50000,"B5")],listed:[[100000,"B1",N],[200000,"B2",N],[300000,"B3",C],[50000,"B4",N]]},
 // A flag or a year does not count as the figure beside a zero.
 {id:75,rows:[["Land cost",0,1]],listed:[[0,"B1",K],[1,"C1",K]]},
 {id:76,rows:[["Land cost",0,2027]],listed:[[0,"B1",K],[2027,"C1","A later figure"]]},
 // A formula line beside a line named only by a concept: the concept may be only part of its cost.
 {id:77,sheet:"Budget",rows:[["Item","Amount"],["Framing",100000],["Mechanical",F(200000)]],listed:[[100000,"B2",P]]},
 // A budget row that is not money, marked not part of the deal, per door, or already counted lists its typed figure and never its computed one.
 {id:78,sheet:"Budget",rows:[["Item","Amount"],["Land",100000],["Interest rate",F("7%")]],reads:[read("land_cost",100000,"B2")]},
 {id:79,sheet:"Budget",rows:[["Item","Amount","Note"],["Land",100000],["Hard cost",F(200000),"Example only"],["Soft cost",5000,"Example only"]],reads:[read("land_cost",100000,"B2")],listed:[[5000,"B4","Marked as not part"]]},
 {id:80,sheet:"Budget",rows:[["Item","Amount"],["Land",100000],["Hard cost",F("$5,000 per door")],["Soft cost","$500 per door"]],reads:[read("land_cost",100000,"B2")],listed:[[500,"B4","A per-door share"]]},
 {id:81,sheet:"Budget",rows:[["Item","Amount"],["Land",100000],["Site works (included in hard costs)",F(5000)],["Fencing (included in hard costs)",7000]],reads:[read("land_cost",100000,"B2")],listed:[[7000,"B4","Already counted"]]},
 // A sentence merged across cells is read once.
 {id:82,rows:[["The land cost is $1,000,000 for the whole site","The land cost is $1,000,000 for the whole site"]],merge:["A1:B1"],reads:[read("land_cost",1000000,"A1")]},
 // A computed figure still shapes the row, the section and the sheet around it, whatever it would read as.
 {id:83,sheet:"Budget",rows:[["Category","Item","Amount","Share"],["Hard costs","Framing",100000,F("$500 per door")],["Hard costs","Mechanical",200000,"note"]],reads:[read("hard_cost",300000,"C2, Budget!C3")]},
 {id:84,sheet:"Budget",rows:[["Item","Amount"],["Land",100000],["Hard costs",200000],["Total",300000],["Contingency",F(30000)]],reads:[read("land_cost",100000,"B2"),read("hard_cost",200000,"B3")],listed:[[300000,"B4",B],[30000,"B5",C]]},
 {id:85,rows:[["Revenue","Homes",1500,F(10)]],listed:[[1500,"C1",N]]},
 {id:86,rows:[["Hard costs","Land cost",F(100)],["Hard costs","Mechanical",F(200)],["Soft costs","Legal",F(50)]],listed:[[100,"C1",C],[200,"C2",C],[50,"C3",C]]},
 {id:87,rows:[["Phase one","Land cost",1000],["Phase one","Hard cost",2000],["Phase one","Soft cost",500],["Contingency",F(1)],["Senior loan",F(2)],["Equity",F(3)]],listed:[[1000,"C1",N],[2000,"C2",N],[500,"C3",N]]},
 {id:88,rows:[["Garden suite"],["Rentable area",F(700)],["Number of units",2]],reads:[read("unit_count",2,"B3","Garden suite")],listed:[[700,"B2",C]]},
 {id:89,rows:[[F("$1,000 CAD"),"Land cost"],["$2,000 CAD","Hard costs"],["$100 CAD","Contingency"]],reads:[read("hard_cost",2000,"A2"),read("contingency",100,"A3")],listed:[[1000,"A1",C]]},
 {id:90,rows:[[F(1),"Annual"],["Property tax",1000]],listed:[[1000,"B2","An itemized operating"]]},
 {id:91,rows:[[null,"Annual"],["Property tax",F(1),1000]],reads:[read("property_tax_annual",1000,"C2")]},
 {id:92,rows:[["Land cost",F("$5,000 per door"),1000000]],reads:[read("land_cost",1000000,"C1")]},
 {id:94,rows:[["The widget fee is $1,000,000 for the whole site","The widget fee is $1,000,000 for the whole site"]],merge:["A1:B1"],listed:[[1000000,"A1","A fee or premium"]]},
 {id:95,rows:[["Hard costs","Framing","Note",1000],["Hard costs","Mechanical","Note",F(2000)],["Hard costs","Drywall","Note",500]],listed:[[2000,"D2",C],[1000,"D1",H],[500,"D3",H]]},
 {id:96,rows:[["Monthly rent - 1-bed",1500,F(2000)]],listed:[[1500,"B1",N]]},
 {id:97,rows:[["Monthly rent - 1-bed",1500]],reads:[read("unit_rent_monthly",1500,"B1","1BR")]},
 {id:98,sheet:"Homes",rows:[["1-bed",10,1500,F(900)]],listed:[[10,"B1",N],[1500,"C1",N]]},
 {id:99,sheet:"Homes",rows:[["1-bed",10,1500]],reads:[read("unit_count",10,"B1","1BR"),read("unit_rent_monthly",1500,"C1","1BR")]},
];
const sorted = (v: unknown[]) => v.map(x=>JSON.stringify(x)).sort();
for (const c of cases) test(`table 1 row ${c.id}`, async () => {
  const sheet=c.sheet??"Inputs";
  const doc=await parseDocument(await book({[sheet]:c}),"invented.xlsx");
  const result=extractCandidates(doc);
  expect(sorted(result.candidates.map(x=>[x.fieldKey,x.value,x.location,...(x.itemKey?[x.itemKey]:[]) ]))).toEqual(sorted((c.reads??[]).map(([k,v,ref,item])=>[k,v,`${sheet}!${ref}`,...(item?[item]:[])])));
  const expected=c.listed??[];
  expect(result.other).toHaveLength(expected.length);
  expect(sorted(result.other.map(x=>[x.value,x.location]))).toEqual(sorted(expected.map(([v,ref])=>[v,`${sheet}!${ref}`])));
  for (const [value, ref, prefix] of expected) {
    const actual = result.other.find(x=>x.value===value && x.location===`${sheet}!${ref}`)!;
    expect(actual.note?.startsWith(prefix), `${sheet}!${ref}`).toBe(true);
  }
  const cell=(ref:string)=>doc.tables[0]!.rows.flat().find(x=>x.ref===`${sheet}!${ref}`)!;
  if(c.id===28){expect(cell("B1").repeat).toBeUndefined();expect(cell("C1").repeat).toBe(true);expect(cell("D1").repeat).toBe(true);}
  if(c.id===30)expect(cell("A2").repeat).toBeUndefined();
  if(c.id===3)expect(cell("B1").computed).toBe(true);
  if(c.id===1)expect(cell("B1").computed).toBeUndefined();
  if(c.id===32)for(let i=1;i<=5;i++)expect(cell(`E${i}`).rowNumber).toBe(true);
  if(c.id===33)expect(cell("E1").rowNumber).toBeUndefined();
  if(c.id===40){expect(doc.notes).toEqual([]);expect(doc.tables.flatMap(t=>t.rows.flat()).some(x=>"computed" in x)).toBe(false);}
});

test("a column is an index when at least half its typed figures equal their own row", async()=>{
 const marked=async(values:number[])=>(await parseDocument(await book({Inputs:{rows:values.map(v=>["Line",v])}}),"index.xlsx")).tables[0]!.rows[0]![1]!.rowNumber;
 expect(await marked([1,2,3,97,98,99])).toBe(true);
 expect(await marked([1,2,96,97,98,99])).toBeUndefined();
});
test("a typed total beside a formula line carries no sum note", async()=>{
 const doc=await parseDocument(await book({Budget:{rows:[["Item","Amount"],["Land",100000],["Hard costs",F(200000)],["Total project cost",300000]]}}),"total.xlsx");
 const total=extractCandidates(doc).candidates.find(c=>c.fieldKey==="stated_total_cost")!;
 expect([total.value,total.note]).toEqual([300000,undefined]);
 const typed=await parseDocument(await book({Budget:{rows:[["Item","Amount"],["Land",100000],["Hard costs",200000],["Total project cost",400000]]}}),"total.xlsx");
 expect(extractCandidates(typed).candidates.find(c=>c.fieldKey==="stated_total_cost")!.note).toContain("does not equal the sum");
});
test("computed row numbers are never marked as an index", async()=>{
 const doc=await parseDocument(await book({Inputs:{rows:Array.from({length:5},(_,i)=>["Line",F(i+1)])}}),"index.xlsx");
 expect(doc.tables[0]!.rows.flat().some(x=>"rowNumber" in x)).toBe(false);
});
const note=(cells:string)=>`This workbook has formulas with no saved results (${cells}). Open and save it in Excel to include them.`;
const fixture=(name:string)=>parseDocument(readFileSync(new URL(`./fixtures/${name}.xlsx`,import.meta.url)),`${name}.xlsx`);
for(const name of ["formula-results","formula-recalc"])test(`raw fixture ${name}`,async()=>{
 const doc=await fixture(name), r=extractCandidates(doc), recalc=name==="formula-recalc";
 expect(doc.notes).toEqual([note(recalc?"B3, B4, B7, B8, B9 and 4 more":"B7")]);
 expect(r.candidates.map(c=>[c.fieldKey,c.value,c.location])).toEqual([["land_cost",1000000,"Budget!B2"]]);
 const expected: [string,string,number|undefined,boolean,boolean][]=[
 ["B2","1000000",1000000,false,false],["B3","0",0,true,false],["B4","false",undefined,true,false],
 ...["B5","B6","B7"].map(ref=>[ref,"",undefined,true,false] as [string,string,undefined,boolean,boolean]),
 ["B8","0",0,true,false],["B9","0",0,true,false],["B10","",undefined,true,false],["B11","2023-03-15",undefined,true,false],["B12","0%",0,true,false],["B13","",undefined,true,false],["B14","x",undefined,true,false],["B15","2",2,true,false],["B16","3000000",3000000,true,false],["C16","3000000",3000000,true,true],["D16","3000000",3000000,true,true],["B17","0",0,true,false],["C17","0",0,true,true]];
 for(const [ref,text,number,computed,repeat] of expected){
 const c=doc.tables[0]!.rows.flat().find(c=>c.ref===`Budget!${ref}`)!;
 const blank=recalc&&["B3","B4","B8","B9","B10","B12","B17","C17"].includes(ref);
 expect({text:c.text,number:c.number,computed:"computed" in c,repeat:"repeat" in c},ref).toEqual({text:blank?"":text,number:blank?undefined:number,computed,repeat});
 }
});
test("raw fixture dates",async()=>{
 const doc=await fixture("dates");expect(doc.notes).toEqual([]);
 expect(doc.tables[0]!.rows[0]!.map(c=>c.text)).toEqual(["Item","2027-01-01","2027-02-01","2027-03-01"]);
 expect(sorted(extractCandidates(doc).candidates.map(c=>[c.fieldKey,c.value,c.location]))).toEqual(sorted([["hard_cost",100000,"Budget!B2"],["land_cost",1000000,"Budget!B5"],["lease_up_months",12,"Budget!B6"]]));
});
for(const name of ["formula-zero","typed-zero"])test(`raw fixture ${name}`,async()=>{
 const doc=await fixture(name);expect(doc.notes).toEqual([]);
 expect(sorted(extractCandidates(doc).candidates.map(c=>[c.fieldKey,c.value,c.location]))).toEqual(sorted([["land_cost",1000000,"Budget!C2"],["hard_cost",1240000,"Budget!C3"],["soft_cost",410000,"Budget!B4"],["other_cost",50000,"Budget!C6"]]));
});
test("blankResults stays linear on missing results and unfinished tags",()=>{
 const missing = '<c r="A1" t="str"><f>x</f>';
 for(const xml of [missing.repeat(Math.ceil(5*1024*1024/missing.length)),"<c "+" ".repeat(5*1024*1024)]){
 const start=performance.now();expect(blankResults(xml)).toBe(xml);expect(performance.now()-start).toBeLessThan(5000);
 }
 for(const v of ["<v></v>","<v/>"])expect(blankResults(`<c r="A1" t="str"><f>""</f>${v}</c>`)).toBe('<c r="A1" t="str"><f>""</f><v> </v></c>');
 for(const xml of ['<c r="A1" t="str"><f>"x"</f><v>x</v></c>','<c r="A1"><f>""</f><v></v></c>'])expect(blankResults(xml)).toBe(xml);
});
test("one thousand missing formula results produce a short note",async()=>{
 const ExcelJS=(await import("exceljs")).default, wb=new ExcelJS.Workbook(), ws=wb.addWorksheet("Inputs");
 for(let i=1;i<=1000;i++)ws.getCell(`A${i}`).value={formula:"1+1"};
 const doc=await parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()),"missing.xlsx");
 expect(doc.notes).toEqual([note("A1, A2, A3, A4, A5 and 995 more")]);
});

test("invented form keeps typed assumptions, concise unused figures and every AI address", async()=>{
const ExcelJS=(await import("exceljs")).default;
type FormValue = string | number | { formula: string; result: number | string };
const f = (result: number | string): FormValue => ({ formula: "1+1", result });
const wb = new ExcelJS.Workbook();
const put = (ws: any, ref: string, v: FormValue) => { ws.getCell(ref).value = v; };
// Every data row of a form sheet numbers itself in a far column, as a lookup index.
const index = (ws: any, col: string, from: number, to: number) => { for (let r = from; r <= to; r++) put(ws, `${col}${r}`, r); };

const summary = wb.addWorksheet("Project Summary");
summary.mergeCells("B3:D3"); put(summary, "B3", "Number of homes"); put(summary, "E3", f(24));
summary.mergeCells("B4:D4"); put(summary, "B4", "Province"); put(summary, "E4", "Ontario");
summary.mergeCells("B5:D5"); put(summary, "B5", "Vacancy rate"); put(summary, "E5", 0.07); summary.getCell("E5").numFmt = "0.00%";
index(summary, "Z", 3, 12);

const sources = wb.addWorksheet("Sources");
["Lender", "Principal", "Rate", "Term", "Amortization"].forEach((h, i) => put(sources, `${"BCDEF"[i]}2`, h));
sources.mergeCells("A3:A3");
put(sources, "A3", "First mortgage"); put(sources, "B3", "Harbour Trust"); put(sources, "C3", 3200000); put(sources, "D3", 6.5); put(sources, "E3", 18); put(sources, "F3", 35);
put(sources, "A4", "Second mortgage"); put(sources, "B4", "Civic Fund"); put(sources, "C4", 400000); put(sources, "D4", 2); put(sources, "E4", 18); put(sources, "F4", 35);
put(sources, "A5", "Total sources"); put(sources, "C5", f(3600000));
index(sources, "Z", 2, 9);

const uses = wb.addWorksheet("Uses");
put(uses, "B2", "Item"); put(uses, "E2", "Per acre"); put(uses, "G2", "Amount");
put(uses, "B3", "Land"); put(uses, "E3", f(572409.85)); put(uses, "G3", 900000);
put(uses, "B4", "Site work"); put(uses, "G4", 300000);
put(uses, "B5", "Hard costs"); put(uses, "G5", 2100000);
put(uses, "B6", "Contingency"); put(uses, "E6", f(120000)); put(uses, "G6", 105000);
put(uses, "B7", "Total development cost"); put(uses, "G7", f(3405000));
index(uses, "BA", 2, 12);

const policy = wb.addWorksheet("Policy");
for (let r = 2; r <= 60; r++) {
  put(policy, `A${r}`, `Section ${r}`);
  put(policy, `B${r}`, `Applicants may claim up to ${r} points where at least ${r * 5} percent of homes meet this standard for ${r} years.`);
  put(policy, `AM${r}`, r);
}

const proForma = wb.addWorksheet("Pro Forma");
put(proForma, "A1", "Rent growth"); put(proForma, "B1", 0.02); proForma.getCell("B1").numFmt = "0.00%";
put(proForma, "A2", "Expense growth"); put(proForma, "B2", f(3));
put(proForma, "A4", "Year");
for (let y = 1; y <= 15; y++) put(proForma, `${String.fromCharCode(65 + y)}4`, y);
for (const [r, label, base] of [[5, "Gross income", 400000], [6, "Operating expenses", 160000], [7, "Net operating income", 240000], [8, "Debt service", 190000]] as const) {
  put(proForma, `A${r}`, label);
  for (let y = 1; y <= 15; y++) put(proForma, `${String.fromCharCode(65 + y)}${r}`, f(base + y * 1000));
}

const amort = wb.addWorksheet("Loan Schedule");
put(amort, "A1", "Loan amount"); put(amort, "B1", f(3200000));
["Month", "Opening", "Interest", "Principal", "Closing"].forEach((h, i) => put(amort, `${"ABCDE"[i]}3`, h));
for (let m = 1; m <= 360; m++) {
  const r = m + 3;
  put(amort, `A${r}`, f(m)); put(amort, `B${r}`, f(3200000 - m * 1000)); put(amort, `C${r}`, f(17000)); put(amort, `D${r}`, f(1000)); put(amort, `E${r}`, f(3199000 - m * 1000));
}

const old = wb.addWorksheet("Uses OLD");
put(old, "B2", "Item"); put(old, "G2", "Amount");
put(old, "B3", "Land"); put(old, "G3", f(850000));
put(old, "B4", "Building"); put(old, "G4", f(1900000));
put(old, "B5", "Total development cost"); put(old, "G5", f(2750000));

const doc=await parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()),"form.xlsx"), r=extractCandidates(doc);
 expect(doc.notes).toEqual([]);
 expect(sorted(r.candidates.map(c=>[c.fieldKey,c.value,c.location]))).toEqual(sorted([
 ["senior_loan_amount",3200000,"Sources!C3"],["mezz_loan_amount",400000,"Sources!C4"],["land_cost",900000,"Uses!G3"],["hard_cost",2100000,"Uses!G5"],["contingency",105000,"Uses!G6"],["rent_growth_pct",2,"Pro Forma!B1"]]));
 expect(r.other).toHaveLength(72);expect(r.other.some(o=>o.value===0)).toBe(false);
 expect(sorted(r.other.filter(o=>o.note?.startsWith(C)).map(o=>[o.location,o.value]))).toEqual(sorted([["Project Summary!E3",24],["Uses!G7",3405000],["Loan Schedule!B1",3200000],["Uses OLD!G3",850000],["Uses OLD!G4",1900000]]));
 expect(r.other.some(o=>o.location.startsWith("Pro Forma!"))).toBe(false);
 expect(r.other.filter(o=>o.location.startsWith("Loan Schedule!")).map(o=>o.location)).toEqual(["Loan Schedule!B1"]);
 const cells=doc.tables.flatMap(t=>t.rows.flat());
 for(const [flag,count] of [["computed",1870],["rowNumber",88],["repeat",6]] as const)expect(cells.filter(c=>flag in c)).toHaveLength(count);
 const ai=addressedText(doc,"form.xlsx");
 for(const ref of ["Project Summary!E3","Uses!G7","Uses!E3","Sources!C5","Loan Schedule!B1","Uses OLD!G3","Project Summary!B3..D3"])expect(ai).toContain(`[${ref}]`);
 // A values-only copy retains all typed values and has no formula provenance.
 wb.eachSheet(ws=>ws.eachRow(row=>row.eachCell(cell=>{if(cell.type===ExcelJS.ValueType.Formula)cell.value=cell.result as never;})));
 const values=await parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()),"values.xlsx");
 expect(values.notes).toEqual([]);expect(values.tables.flatMap(t=>t.rows.flat()).some(c=>"computed" in c)).toBe(false);
});
