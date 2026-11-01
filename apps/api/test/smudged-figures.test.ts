import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { drain, type WorkerDeps } from "@agir/worker";
import { AI_AMBIGUOUS_NOTE } from "@agir/extraction";
import { createApp } from "../src/app.ts";

let db: Db, app: ReturnType<typeof createApp>, cookie: string, ws: string;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-smudged-")));
const quote = "Land $ _1,025,000.00";
async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { cookie, "x-agir": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(res.status).toBe(200); return res.json() as Promise<any>;
}
beforeAll(async () => {
  db = await openPglite(); await migrate(db); app = createApp({ db, store, secureCookies: false });
  const res = await app.request("/api/auth/signup", { method: "POST", headers: { "x-agir": "1", "content-type": "application/json" }, body: JSON.stringify({ email: "smudged@example.com", name: "Invented figures", password: "correct horse battery" }) });
  expect(res.status).toBe(200); cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  ws = (await call("GET", "/api/me")).workspaces[0].id;
});
afterAll(async () => { await db.close(); });

test("a smudged scanned figure reaches Review as a value to check", async () => {
  const pdf = await PDFDocument.create();
  const canvas = createCanvas(816, 1056), ctx = canvas.getContext("2d");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, 816, 1056);
  ctx.fillStyle = "black"; ctx.font = "32px sans-serif"; ctx.fillText(quote, 55, 140);
  const image = await pdf.embedPng(canvas.toBuffer("image/png"));
  pdf.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  const deal = (await call("POST", `/api/workspaces/${ws}/deals`, { name: "Invented smudged scan", assetType: "Multifamily" })).id;
  const upload = await app.request(`/api/deals/${deal}/documents?name=invented.pdf`, { method: "PUT", headers: { cookie, "x-agir": "1" }, body: new Uint8Array(await pdf.save()) });
  expect(upload.status).toBe(200);
  const ocr = vi.fn<NonNullable<WorkerDeps["ocr"]>>(async () => ({ pages: [{ page: 1, lines: [{ text: quote, confidence: 90 }] }], failed: [] }));
  const read = vi.fn<NonNullable<WorkerDeps["read"]>>(async () => ({ readings: [{ field: "land_cost", item: null, value: 1025000, unit_seen: "$", file: "invented.pdf", location: "page 1, line 1", quote, note: null, confidence: "high" }], conflicts: [], not_used: [] }));
  await drain({ db, store, ocr, read });
  expect(ocr).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(1);
  const [row] = await db.query<any>(`select verification from ai_readings where deal_id=$1`, [deal]);
  expect(row.verification.readings).toMatchObject([{ outcome: "verified", candidate: { value: 1025000, raw: "1,025,000.00", ambiguous: true, ocr: true } }]);
  const review = await call("GET", `/api/deals/${deal}/review`);
  const land = review.assumptions.find((a: any) => a.fieldKey === "land_cost");
  expect(land).toMatchObject({ value: 1025000 });
  expect(land.sources).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "ai", ocr: true, check_note: AI_AMBIGUOUS_NOTE })]));
  expect(review.aiReading.pleaseCheck).toEqual([]);
});
