import { expect, test } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { tiffBytes } from "@agir/testkit";
import * as extraction from "../src/index.ts";
import JSZip from "jszip";
import ExcelJS from "exceljs";

const damaged = "Agir could not open this picture. It may be damaged. Upload it again, or save it as a PDF.";
const canvas = createCanvas(816, 1056), ctx = canvas.getContext("2d");
ctx.fillStyle = "white"; ctx.fillRect(0, 0, 816, 1056); ctx.fillStyle = "black"; ctx.font = "32px sans-serif"; ctx.fillText("Land cost $400,000", 55, 140);
const png = canvas.toBuffer("image/png"), jpeg = canvas.toBuffer("image/jpeg");
const rgba = ctx.getImageData(0, 0, 816, 1056).data;
const gray = Uint8Array.from({ length: 816 * 1056 }, (_, i) => rgba[i * 4]!);
// EXIF orientation 6 restores these pixels, turned 90 degrees counterclockwise.
const turned = createCanvas(1056, 816), tc = turned.getContext("2d");
tc.translate(0, 816); tc.rotate(-Math.PI / 2); tc.drawImage(canvas, 0, 0);
const exif = Buffer.from([0xff, 0xe1, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
const turnedJpeg = turned.toBuffer("image/jpeg");
const oriented = Buffer.concat([turnedJpeg.subarray(0, 2), exif, turnedJpeg.subarray(2)]);

test.each(["png", "jpg", "jpeg", "tif", "tiff", "PNG", "JPG", "JPEG", "TIF", "TIFF"])("picture extension %s", ext => {
  expect(extraction.kindOf(`photo.${ext}`)).toBe("image");
});
test.each([png, jpeg])("strict image endings and trailing photo data", bytes => {
  const trailing = Buffer.concat([bytes, Buffer.from("motion photo data")]);
  expect(extraction.imageInfo(bytes)).toEqual(expect.objectContaining({ width: 816, height: 1056 }));
  expect(extraction.imageInfo(trailing)).toBe("unreadable");
  expect(extraction.imageInfo(trailing, { allowTrailing: true })).toEqual(extraction.imageInfo(bytes));
  expect(extraction.imageInfo(bytes.subarray(0, -20), { allowTrailing: true })).toBe("unreadable");
});
test("pictureInfo reads bytes and TIFF directory chains safely", () => {
  for (const bytes of [png, jpeg]) expect(extraction.pictureInfo(bytes)).toMatchObject({ width: 816, height: 1056, pages: 1 });
  for (const bigEndian of [false, true]) {
    for (const pages of [1, 3]) expect(extraction.pictureInfo(tiffBytes(2, 3, new Uint8Array(6), { bigEndian, pages }))).toEqual({ format: "tiff", width: 2, height: 3, pages });
  }
  const outside = tiffBytes(1, 1, new Uint8Array(1)); new DataView(outside.buffer).setUint32(4, 999999, true);
  const cycle = tiffBytes(1, 1, new Uint8Array(1)); new DataView(cycle.buffer).setUint32(8 + 2 + 9 * 12, 8, true);
  const missing = tiffBytes(1, 1, new Uint8Array(1)); new DataView(missing.buffer).setUint16(10, 999, true);
  for (const bytes of [outside, cycle, missing, png.subarray(0, -20)]) expect(extraction.pictureInfo(bytes)).toBe("unreadable");
  expect(extraction.pictureInfo(tiffBytes(1, 1, new Uint8Array(1), { pages: 1000 }))).toMatchObject({ pages: 1000 });
  expect(extraction.pictureInfo(tiffBytes(1, 1, new Uint8Array(1), { pages: 1001 }))).toBe("unreadable");
  expect(extraction.pictureInfo(new Uint8Array([1, 2, 3]))).toBe("unknown");
  for (let n = 0; n < outside.length; n++) expect(() => extraction.pictureInfo(outside.subarray(0, n))).not.toThrow();
});
test("picture parser is a decoder-free OCR placeholder and refuses damaged, multipage and oversized pictures", async () => {
  expect(await extraction.parseDocument(png, "anything.jpg")).toEqual({ kind: "image", lines: [], tables: [], pageCount: 1, needsOcr: true, ocrPages: [1], fullText: "" });
  for (const bytes of [new Uint8Array([1, 2]), png.subarray(0, -20)]) await expect(extraction.parseDocument(bytes, "p.png")).rejects.toThrow(damaged);
  await expect(extraction.parseDocument(tiffBytes(1, 1, new Uint8Array(1), { pages: 2 }), "p.tif")).rejects.toThrow("This TIFF has 2 pages. Save it as a PDF, then upload that.");
  const large = Buffer.from(png); large.writeUInt32BE(9000, 16); large.writeUInt32BE(9000, 20);
  await expect(extraction.parseDocument(large, "p.png")).rejects.toThrow("This picture is 81 megapixels, and Agir reads pictures of up to 80. Save a smaller copy, then upload it.");
});
test.each([
  ["heic", "Agir cannot read HEIC photos. Export the photo as JPEG, then upload it."],
  ["heif", "Agir cannot read HEIC photos. Export the photo as JPEG, then upload it."],
  ["xls", "Agir reads Excel files saved as .xlsx. Open this one in Excel, save it as .xlsx, then upload it."],
  ["doc", "Agir reads Word files saved as .docx. Open this one in Word, save it as .docx, then upload it."],
  ["ppt", "Agir does not read PowerPoint files. Save this one as a PDF, then upload that."],
  ["pptx", "Agir does not read PowerPoint files. Save this one as a PDF, then upload that."],
  ["zip", "Upload a PDF, Excel (.xlsx), CSV, Word (.docx), text file, or a picture (PNG, JPEG or TIFF)."],
])("actionable refusal for %s", async (ext, message) => {
  expect(extraction.refusalFor(`file.${ext.toUpperCase()}`)).toBe(message);
  await expect(extraction.parseDocument(new Uint8Array(), `file.${ext}`)).rejects.toThrow(message);
});
test.each([["PNG", png], ["JPEG", jpeg], ["big-endian TIFF", tiffBytes(816, 1056, gray, { bigEndian: true })], ["EXIF orientation 6", oriented]] as const)("real image OCR: %s", async (_name, bytes) => {
  const result = await extraction.ocrImage(bytes);
  expect(result.failed).toEqual([]); expect(result.pages[0]?.page).toBe(1);
  expect(result.pages[0]?.lines.map(l => l.text).join(" ")).toContain("400,000");
}, 60_000);
test("real truncated TIFF fails without throwing or exiting", async () => {
  expect(await extraction.ocrImage(tiffBytes(816, 1056, gray).subarray(0, 120))).toEqual({ pages: [], failed: [1] });
}, 60_000);
test.each(["docx", "xlsx"])("%s counts large media entries from the real ZIP", async kind => {
  for (const sizes of [[20000], [20000, 25000], [19999]]) {
    let zip: JSZip;
    if (kind === "xlsx") {
      const wb = new ExcelJS.Workbook(); wb.addWorksheet("Values").getCell("A1").value = "Land cost $400,000";
      zip = await JSZip.loadAsync(await wb.xlsx.writeBuffer());
    } else {
      zip = new JSZip();
      zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
      zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
      zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Land cost $400,000</w:t></w:r></w:p></w:body></w:document>');
    }
    sizes.forEach((size, i) => zip.file(`${kind === "docx" ? "word" : "xl"}/media/image${i}.png`, Buffer.alloc(size, i + 1)));
    zip.file("other/media/large.png", Buffer.alloc(30000));
    const parsed = await extraction.parseDocument(await zip.generateAsync({ type: "uint8array" }), `file.${kind}`);
    const count = sizes.filter(size => size >= 20000).length;
    expect(parsed.notes ?? []).toEqual(count ? [`This file has ${count} ${count === 1 ? "picture" : "pictures"}. Agir does not read pictures inside Word or Excel files, so check ${count === 1 ? "it" : "them"} for figures.`] : []);
  }
});
