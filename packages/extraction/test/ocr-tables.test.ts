import { expect, test } from "vitest";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { pageFont, scanPdf } from "@agir/testkit";
import { ocrImage, ocrPdf } from "../src/ocr.ts";

const font = pageFont();
const rows = [
  ["Land", "1,250,000"], ["Hard costs", "8,430,000"], ["Soft costs", "1,120,500"],
  ["Contingency", "421,500"], ["Financing fees", "96,250"], ["Interest reserve", "514,000"],
  ["Total uses", "11,832,250"], ["Senior loan", "7,600,000"], ["Mezzanine loan", "1,250,000"],
  ["Common equity", "2,982,250"], ["Total sources", "11,832,250"], ["Gross rent", "1,412,000"],
  ["Operating costs", "498,300"], ["Property tax", "171,400"], ["Net income", "742,300"],
] as const;

function page(rule = 0, band = false): Canvas {
  const canvas = createCanvas(2550, 3300), ctx = canvas.getContext("2d");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "black"; ctx.font = `bold 56px ${font}`;
  ctx.fillText("Sources and uses of funds", 200, 260);
  ctx.font = `40px ${font}`;
  ctx.fillText("The figures below come from the owner's budget for this invented building and were reviewed in spring.", 200, 340);
  const left = 200, mid = 1500, right = 2350, y = 520;
  if (band) ctx.fillRect(left, y - 70, right - left, 70);
  ctx.fillStyle = band ? "white" : "black"; ctx.font = `bold 40px ${font}`;
  ctx.fillText("Item", left + 30, y - 24); ctx.fillText("Amount", mid + 30, y - 24);
  ctx.fillStyle = "black"; ctx.font = `40px ${font}`;
  rows.forEach(([item, amount], i) => {
    ctx.fillText(item, left + 30, y + i * 86 + 58);
    ctx.fillText(amount, mid + 30, y + i * 86 + 58);
  });
  ctx.fillText("Note 1: all figures are invented and stand for no real project anywhere.", 200, y + 15 * 86 + 90);
  ctx.fillText("Note 2: the loan closes after the permit is issued.", 200, y + 15 * 86 + 150);
  if (rule) {
    ctx.strokeStyle = "black"; ctx.lineWidth = rule; ctx.beginPath();
    for (const at of [y - 70, ...Array.from({ length: 16 }, (_, i) => y + i * 86)]) {
      ctx.moveTo(left, at); ctx.lineTo(right, at);
    }
    for (const at of [left, mid, right]) { ctx.moveTo(at, y - 70); ctx.lineTo(at, y + 15 * 86); }
    ctx.stroke();
  }
  return canvas;
}
function turn(source: Canvas, degrees: number) {
  const swap = degrees === 90 || degrees === 270;
  const canvas = createCanvas(swap ? source.height : source.width, swap ? source.width : source.height);
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(degrees * Math.PI / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}
test.each([
  ["3 px grid", 3, false, 0, false, false, 13],
  ["6 px grid", 6, false, 0, false, false, 13],
  ["black header band", 3, true, 0, false, false, 13],
  ["scanned PDF grid", 3, false, 0, true, false, 13],
  ["plain turned 90", 0, false, 90, false, false, 13],
  ["plain turned 180", 0, false, 180, false, false, 13],
  ["plain turned 270", 0, false, 270, false, false, 13],
  ["grid turned 180", 3, false, 180, false, false, 13],
  ["plain at 1100 px", 0, false, 0, false, true, 6],
] as const)("%s retains whole table rows", async (_name, rule, band, rotation, pdf, small, minimum) => {
  let canvas = page(rule, band);
  if (rotation) canvas = turn(canvas, rotation);
  if (small) {
    const reduced = createCanvas(850, 1100);
    reduced.getContext("2d").drawImage(canvas, 0, 0, reduced.width, reduced.height); canvas = reduced;
  }
  const result = pdf ? await ocrPdf(await scanPdf(canvas.toBuffer("image/jpeg", 90))) : await ocrImage(canvas.toBuffer("image/png"));
  expect(result.failed).toEqual([]);
  const lines = result.pages.flatMap(p => p.lines);
  const whole = rows.filter(([item, amount]) => lines.some(line => line.text.includes(item) && line.text.includes(amount)));
  expect(whole.length, JSON.stringify(lines)).toBeGreaterThanOrEqual(minimum);
}, 120_000);

const prose = [
  "This left column is plain running text about a building",
  "that does not exist. It goes on for a few lines so that",
  "the column holds real sentences beside the table on the",
  "right of the sheet, as a brochure or a staff report would.",
  "Nothing in these sentences is a figure and none of them",
  "should end up with an amount from the other column.",
];
function bare(draw: (ctx: ReturnType<Canvas["getContext"]>) => void, skew = 0) {
  const canvas = createCanvas(2550, 3300), ctx = canvas.getContext("2d");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "black"; ctx.font = `40px ${font}`;
  if (skew) { ctx.translate(1275, 1650); ctx.rotate(skew * Math.PI / 180); ctx.translate(-1275, -1650); }
  draw(ctx);
  return canvas;
}
const table = (ctx: ReturnType<Canvas["getContext"]>, item: number, amount: number) =>
  rows.forEach(([name, figure], i) => { ctx.fillText(name, item, 578 + i * 86); ctx.fillText(figure, amount, 578 + i * 86); });
test.each([
  ["a table alone, wide gap", () => bare(ctx => table(ctx, 230, 1530))],
  ["a table alone, narrow gap", () => bare(ctx => table(ctx, 230, 800))],
  ["a table alone, tilted 2 degrees", () => bare(ctx => table(ctx, 230, 1530), 2)],
  ["a table alone, turned 90", () => turn(bare(ctx => table(ctx, 230, 1530)), 90)],
  ["a table alone, turned 180", () => turn(bare(ctx => table(ctx, 230, 1530)), 180)],
  ["a table alone, turned 270", () => turn(bare(ctx => table(ctx, 230, 1530)), 270)],
  ["a table alone, tilted 2 degrees and turned 90", () => turn(bare(ctx => table(ctx, 230, 1530), 2), 90)],
  ["a table beside prose", () => bare(ctx => {
    prose.forEach((text, i) => ctx.fillText(text, 150, 578 + i * 86));
    ctx.font = `36px ${font}`; table(ctx, 1450, 2050);
  })],
] as const)("%s keeps each amount on its name's line", async (_name, draw) => {
  const result = await ocrImage(draw().toBuffer("image/png"));
  const lines = result.pages.flatMap(p => p.lines);
  const whole = rows.filter(([item, amount]) => lines.some(line => line.text.includes(item) && line.text.includes(amount)));
  expect(whole.length, JSON.stringify(lines)).toBeGreaterThanOrEqual(13);
  // Prose keeps its own sentences: no long line takes an amount.
  expect(lines.filter(line => (line.text.match(/\p{L}{2,}/gu) ?? []).length > 8 && /\d,\d{3}/.test(line.text))).toEqual([]);
}, 120_000);
