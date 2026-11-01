import { expect, test } from "vitest";
import { listedFigures } from "../src/services.ts";

const computed = "Worked out by a formula in this workbook, so Agir did not read it. Use it if it is the figure you want";
const row = (i: number, documentId = "A") => ({ documentId, location: `Budget!B${i}`, context: `Invented line ${i}`, raw: String(1000 + i), value: 1000 + i as number | null, note: null as string | null, figureId: `${documentId}-${i}` as string | null, label: null as { fieldKey: string } | null, suggestions: [] as string[] });
const rows = (n: number, id = "A") => Array.from({ length: n }, (_, i) => row(i + 1, id));
const list = (rs: ReturnType<typeof rows>, named = new Set<string>()) => listedFigures(rs, named);

test("card 199: 1,000 figures preserve array identity", () => {
  const rs = rows(1000), result = list(rs);
  expect(result.listed).toBe(rs); expect(result.total).toBe(1000);
});
test("card 199: repeated document, context and raw count once", () => {
  const rs = rows(1000); rs.push(...rs.slice(0, 500).map(r => ({ ...r, location: "Budget!B5000" })));
  const result = list(rs); expect(result.listed).toBe(rs); expect(result.total).toBe(1000);
});
test("card 199: selection uses numeric row order and preserves given order", () => {
  const rs = rows(1001).sort((a, b) => a.location.localeCompare(b.location)), result = list(rs);
  expect(result.total).toBe(1001); expect(result.listed).toHaveLength(1000);
  expect(result.listed).not.toContain(rs.find(r => r.location === "Budget!B1001"));
  expect(result.listed).toContain(rs.find(r => r.location === "Budget!B999"));
  expect(result.listed).toEqual(rs.filter(r => r.location !== "Budget!B1001"));
});
test("card 199: every labelled figure stays even over 1,000", () => {
  const rs = rows(1200).map(r => ({ ...r, label: { fieldKey: "land_cost" } }));
  expect(list(rs).listed).toEqual(rs);
});
test("card 199: labelled, computed, named and suggested tail figures stay", () => {
  const rs = rows(1100), tail = rs.slice(-9);
  tail.slice(0, 3).forEach(r => { r.label = { fieldKey: "land_cost" }; });
  tail.slice(3, 5).forEach(r => { r.note = computed; });
  tail.slice(7).forEach(r => { r.suggestions = ["land_cost"]; });
  const result = list(rs, new Set(tail.slice(5, 7).map(r => r.figureId!)));
  expect(result.total).toBe(1100); expect(result.listed).toHaveLength(1000);
  expect(result.listed).toEqual(expect.arrayContaining(tail));
});
test.each(["computed", "suggested"])("card 199: 1,000 %s figures precede a plain figure", tier => {
  const rs = rows(1001);
  rs.slice(1).forEach(r => { if (tier === "computed") r.note = computed; else r.suggestions = ["land_cost"]; });
  expect(list(rs).listed).toEqual(rs.slice(1));
});
test("card 199: the list stops at the cap partway through a round of files", () => {
  const result = list([...rows(1000, "A"), ...rows(1000, "B"), ...rows(1000, "C")]);
  expect(result.total).toBe(3000); expect(result.listed).toHaveLength(1000);
  expect(["A", "B", "C"].map(id => result.listed.filter(r => r.documentId === id).length)).toEqual([334, 333, 333]);
});
test("card 199: files take turns and small files remain whole", () => {
  const rs = [...rows(1500, "A"), ...rows(20, "B"), ...rows(1500, "C")], result = list(rs);
  expect(["A", "B", "C"].map(id => result.listed.filter(r => r.documentId === id).length)).toEqual([490, 20, 490]);
});
test("card 199: both rows of an excluded figure are omitted", () => {
  const rs = rows(1001); rs.push({ ...rs[1000]!, location: "Budget!B5000" });
  const result = list(rs); expect(result.total).toBe(1001); expect(result.listed).toHaveLength(1000);
  expect(result.listed.some(r => ["Budget!B1001", "Budget!B5000"].includes(r.location))).toBe(false);
});
test("card 199: both rows of an included figure stay in given order", () => {
  const rs = rows(1001); rs.unshift({ ...rs[0]!, location: "Budget!B5000" });
  const result = list(rs); expect(result.total).toBe(1001); expect(result.listed).toHaveLength(1001);
  expect(result.listed[0]).toBe(rs[0]); expect(result.listed).toContain(rs[1]);
  expect(result.listed).toEqual(rs.filter(r => r.location !== "Budget!B1001"));
});
test("card 199: unused counts only unlabelled figures with a value and id", () => {
  const rs = rows(4); rs[1]!.figureId = null; rs[2]!.value = null; rs[3]!.label = { fieldKey: "land_cost" };
  expect(list(rs).unused).toBe(1);
});
