import { reportText } from "./text.ts";
import type { Block, DocModel } from "./model.ts";

/** The same document model as Word. Every string comes from the model, so provenance carries over. */
export async function renderDocx(m: DocModel): Promise<Uint8Array> {
  const d = await import("docx");
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel, BorderStyle, ImageRun } = d;
  const font = "IBM Plex Sans";
  const run = (text: string, opts: { bold?: boolean; size?: number; color?: string; mono?: boolean; italics?: boolean } = {}) =>
    new TextRun({ text, bold: opts.bold, size: opts.size ?? 20, color: opts.color ?? "15171C", font: opts.mono ? "IBM Plex Mono" : font, italics: opts.italics });
  const rule = { style: BorderStyle.SINGLE, size: 4, color: "DDD8CC" };
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
  if (m.banner) children.push(new Paragraph({ children: [run(m.banner)] }));
  if (m.brand) {
    const { logo, preparedBy } = m.brand;
    children.push(new Paragraph({ spacing: { after: 160 }, children: [
      new ImageRun({ type: logo.mime === "image/png" ? "png" : "jpg", data: logo.bytes, transformation: { width: logo.width, height: logo.height } }),
      run(`   ${preparedBy}`, { size: 18, color: "454A55" }),
    ] }));
  }
  children.push(new Paragraph({ children: [run(m.kicker.toUpperCase(), { size: 16, color: "454A55" })] }));
  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: m.title, font: "Newsreader", size: 56 })] }));
  children.push(new Paragraph({ spacing: { after: 240 }, children: [run(m.meta, { color: "454A55" })] }));
  const block = (b: Block) => {
    switch (b.type) {
      case "heading":
        children.push(new Paragraph({ spacing: { before: 240, after: 80 }, children: [run(b.text, { bold: true, size: 22 })] }));
        break;
      case "paragraph":
        children.push(new Paragraph({ children: [run(b.text, { color: b.muted ? "454A55" : "15171C" })] }));
        break;
      case "verdict":
        children.push(new Paragraph({ children: [run(b.label.toUpperCase(), { bold: true, size: 18 })] }));
        children.push(new Paragraph({ children: [new TextRun({ text: b.headline, font: "Newsreader", size: 32 })] }));
        children.push(new Paragraph({ spacing: { after: 200 }, children: [run(b.explanation, { color: "454A55" })] }));
        break;
      case "stats":
        children.push(
          new Paragraph({
            spacing: { after: 200 },
            children: b.items.flatMap((i, n) => [run(`${n ? "   |   " : ""}${i.label}: `, { color: "454A55", size: 18 }), run(i.value, { mono: true, size: 18 })]),
          }),
        );
        // A figure's plain sentence, one line each, under the figures.
        for (const i of b.items.filter((x) => x.note)) children.push(new Paragraph({ children: [run(`${i.label}: `, { color: "454A55", size: 16 }), run(i.note!, { color: "454A55", size: 16 })] }));
        break;
      case "table": {
        if (b.caption) children.push(new Paragraph({ spacing: { before: 200, after: 80 }, children: [run(b.caption, { bold: true })] }));
        const header = new TableRow({
          tableHeader: true,
          children: b.columns.map(
            (c) =>
              new TableCell({
                borders: { top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, bottom: { style: BorderStyle.SINGLE, size: 6, color: "15171C" } },
                children: [new Paragraph({ alignment: c.numeric ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [run(c.label, { size: 16, color: "454A55" })] })],
              }),
          ),
        });
        const rows = b.rows.map(
          (r, i) =>
            new TableRow({
              children: r.map(
                (cell, j) =>
                  new TableCell({
                    borders: { top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, bottom: rule },
                    children: [
                      new Paragraph({
                        alignment: b.columns[j]?.numeric ? AlignmentType.RIGHT : AlignmentType.LEFT,
                        children: [run(cell, { mono: b.columns[j]?.numeric, bold: b.strong?.includes(i), size: 18 })],
                      }),
                    ],
                  }),
              ),
            }),
        );
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...rows] }));
        break;
      }
      case "checks":
        for (const i of b.items) {
          children.push(new Paragraph({ children: [run(`${reportText(m.lang, i.tone === "pass" ? "pass" : i.tone === "warning" ? "check" : "fails")}  `, { bold: true, size: 18 }), run(i.text, { size: 18 })] }));
        }
        break;
    }
  };
  m.blocks.forEach(block);
  children.push(new Paragraph({ spacing: { before: 300 }, children: [run(m.footer, { size: 16, color: "454A55" })] }));
  const doc = new Document({
    creator: "Agir",
    title: `${m.title} - ${m.kicker}`,
    styles: { default: { document: { run: { font, size: 20 } } } },
    sections: [{ properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } }, children }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/** The text of the Word document, for the provenance scan. */
export function docxText(m: DocModel): string {
  const parts: string[] = [...(m.banner ? [m.banner] : []),...(m.brand ? [m.brand.preparedBy] : []), m.kicker, m.title, m.meta, m.footer];
  for (const b of m.blocks) {
    if (b.type === "heading" || b.type === "paragraph") parts.push(b.text);
    else if (b.type === "verdict") parts.push(b.label, b.headline, b.explanation);
    else if (b.type === "stats") for (const i of b.items) parts.push(i.label, i.value, ...(i.note ? [i.note] : []));
    else if (b.type === "table") {
      if (b.caption) parts.push(b.caption);
      parts.push(...b.columns.map((c) => c.label), ...b.rows.flat());
    } else if (b.type === "checks") parts.push(...b.items.map((i) => i.text));
  }
  return parts.join(" ");
}
