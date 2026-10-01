import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class RendererUnavailableError extends Error {}

/** Find a headless Chromium: AGIR_CHROMIUM_PATH, or the newest one Playwright has cached. */
export function findChromium(): string | undefined {
  if (process.env.AGIR_CHROMIUM_PATH) return process.env.AGIR_CHROMIUM_PATH;
  const roots = [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root)
      .filter((d) => d.startsWith("chromium_headless_shell-") || d.startsWith("chromium-"))
      .sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()));
    for (const d of dirs) {
      for (const rel of [
        "chrome-headless-shell-mac-arm64/chrome-headless-shell",
        "chrome-headless-shell-mac-x64/chrome-headless-shell",
        "chrome-headless-shell-linux64/chrome-headless-shell",
        "chrome-linux/chrome",
      ]) {
        const p = join(root, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

/** HTML to a Letter PDF with headless Chromium. */
export async function htmlToPdf(html: string): Promise<Uint8Array> {
  const { chromium } = await import("playwright-core");
  const executablePath = findChromium();
  let browser;
  try {
    browser = await chromium.launch(executablePath ? { executablePath } : {});
  } catch (e) {
    throw new RendererUnavailableError(
      `PDF rendering needs a headless Chromium. Set AGIR_CHROMIUM_PATH or install one with "npx playwright-core install chromium-headless-shell". (${(e as Error).message.split("\n")[0]})`,
    );
  }
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "Letter", printBackground: true, preferCSSPageSize: true });
    return new Uint8Array(pdf);
  } finally {
    await browser.close();
  }
}
