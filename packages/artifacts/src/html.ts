import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Block, DocModel } from "./model.ts";

const require = createRequire(import.meta.url);

function fontFace(family: string, pkgFile: string, weight: string, style = "normal"): string {
  try {
    const data = readFileSync(require.resolve(pkgFile)).toString("base64");
    return `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${data}) format('woff2');font-weight:${weight};font-style:${style};}`;
  } catch {
    return "";
  }
}

let fontsCss: string | null = null;
function fonts(): string {
  if (fontsCss !== null) return fontsCss;
  fontsCss = [
    fontFace("IBM Plex Sans", "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2", "400"),
    fontFace("IBM Plex Sans", "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2", "500"),
    fontFace("IBM Plex Sans", "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2", "600"),
    fontFace("IBM Plex Mono", "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", "400"),
    fontFace("IBM Plex Mono", "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2", "500"),
    fontFace("Newsreader", "@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2", "200 800"),
  ].join("");
  return fontsCss;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const VERDICT_COLOR = { APPROVE: "#2350C8", APPROVE_WITH_CONDITIONS: "#9A6212", REJECT: "#C8401F", NOT_EVALUATED: "#626773" } as const;
const TONE = {
  pass: { bg: "#E4EAF8", fg: "#1B45B0", word: "Pass" },
  warning: { bg: "#F6ECD4", fg: "#8A5A00", word: "Check" },
  error: { bg: "#F8E3DC", fg: "#B3361A", word: "Fails" },
} as const;

function block(b: Block): string {
  switch (b.type) {
    case "heading":
      return `<h2>${esc(b.text)}</h2>`;
    case "paragraph":
      return `<p class="${b.muted ? "muted" : ""}">${esc(b.text)}</p>`;
    case "verdict":
      return `<section class="verdict" style="border-color:${VERDICT_COLOR[b.code]}">
        <span class="badge" style="background:${VERDICT_COLOR[b.code]}">${esc(b.label)}</span>
        <div><p class="headline">${esc(b.headline)}</p><p class="explain">${esc(b.explanation)}</p></div></section>`;
    case "stats":
      return `<div class="stats">${b.items.map((i) => `<div><span class="label">${esc(i.label)}</span><span class="num big">${esc(i.value)}</span></div>`).join("")}</div>`;
    case "table":
      return `<section class="tbl">${b.caption ? `<h3>${esc(b.caption)}</h3>` : ""}<table><thead><tr>${b.columns
        .map((c) => `<th class="${c.numeric ? "r" : ""}">${esc(c.label)}</th>`)
        .join("")}</tr></thead><tbody>${b.rows
        .map(
          (r, i) =>
            `<tr class="${b.strong?.includes(i) ? "strong" : ""}">${r
              .map((cell, j) => `<td class="${b.columns[j]?.numeric ? "r num" : ""}">${esc(cell)}</td>`)
              .join("")}</tr>`,
        )
        .join("")}</tbody></table></section>`;
    case "checks":
      return `<ul class="checks">${b.items
        .map((i) => `<li><span class="tag" style="background:${TONE[i.tone].bg};color:${TONE[i.tone].fg}">${TONE[i.tone].word}</span><span>${esc(i.text)}</span></li>`)
        .join("")}</ul>`;
  }
}

/** The artifact as one self-contained HTML page (Ink & Signal), for screen and for PDF. */
export function renderHtml(m: DocModel): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(m.title)} · ${esc(m.kicker)}</title><style>
${fonts()}
@page{size:Letter;margin:0.75in 0.75in 0.7in}
*{box-sizing:border-box}
body{margin:0;font-family:'IBM Plex Sans',system-ui,sans-serif;color:#15171C;font-size:10.5pt;line-height:1.45;background:#fff}
.mast{display:flex;justify-content:space-between;align-items:center;padding-bottom:8pt;border-bottom:1px solid #15171C;font-size:8.5pt;text-transform:uppercase;letter-spacing:.08em;color:#454A55}
.mark{display:flex;align-items:center;gap:6pt;text-transform:none;letter-spacing:0}
.mark i{display:block;width:7pt;height:7pt;background:#15171C}
.mark b{font-family:'Newsreader',Georgia,serif;font-style:italic;font-weight:500;font-size:13pt;color:#15171C}
h1{font-family:'Newsreader',Georgia,serif;font-weight:500;font-size:30pt;line-height:1.05;letter-spacing:-.015em;margin:16pt 0 4pt}
.meta{color:#454A55;font-size:9.5pt;margin:0 0 14pt}
.verdict{display:flex;gap:14pt;align-items:flex-start;border:1px solid;border-radius:4px;padding:12pt 14pt;margin:0 0 14pt;break-inside:avoid}
.badge{color:#fff;font-size:8pt;font-weight:600;letter-spacing:.08em;text-transform:uppercase;padding:4pt 8pt;border-radius:3px;white-space:nowrap}
.headline{font-family:'Newsreader',Georgia,serif;font-size:16pt;line-height:1.25;margin:0 0 3pt}
.explain{margin:0;color:#454A55}
.stats{display:grid;grid-template-columns:repeat(5,1fr);border-top:1px solid #15171C;border-bottom:1px solid #DDD8CC;margin:0 0 16pt}
.stats div{display:flex;flex-direction:column;gap:3pt;padding:8pt 8pt 8pt 0}
.stats div+div{border-left:1px solid #DDD8CC;padding-left:8pt}
.label{font-size:8pt;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:#454A55}
.num{font-family:'IBM Plex Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}
.big{font-size:13pt}
h2{font-size:11pt;font-weight:600;margin:14pt 0 6pt}
h3{font-size:10.5pt;font-weight:600;margin:0 0 5pt}
.tbl{margin:0 0 14pt;break-inside:avoid}
table{width:100%;border-collapse:collapse;font-size:9.5pt}
th{text-align:left;font-size:8pt;font-weight:500;color:#454A55;border-bottom:1px solid #15171C;padding:4pt 6pt 4pt 0}
td{padding:4pt 6pt 4pt 0;border-bottom:1px solid #DDD8CC;vertical-align:top}
.r{text-align:right}
tr.strong td{font-weight:600;border-bottom:1px solid #15171C}
.checks{list-style:none;margin:0 0 14pt;padding:0}
.checks li{display:flex;gap:8pt;align-items:flex-start;padding:5pt 0;border-bottom:1px solid #DDD8CC}
.tag{font-size:8pt;font-weight:600;padding:1pt 6pt;border-radius:3px;white-space:nowrap}
p{margin:0 0 8pt}
.muted{color:#454A55}
footer{margin-top:16pt;padding-top:8pt;border-top:1px solid #DDD8CC;font-size:8.5pt;color:#454A55}
</style></head><body>
<div class="mast"><span class="mark"><i></i><b>agir</b></span><span>${esc(m.kicker)}</span></div>
<h1>${esc(m.title)}</h1>
<p class="meta">${esc(m.meta)}</p>
${m.blocks.map(block).join("\n")}
<footer>${esc(m.footer)}</footer>
</body></html>`;
}

/** Visible text of the rendered page, for the provenance scan. */
export function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}
