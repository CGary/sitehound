import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

export interface PageCapture {
  html: string;
  screenshot: string;
  meta: string;
}

/** Saves the rendered HTML, a full-page screenshot and basic metadata. */
export async function capturePage(page: Page, outDir: string): Promise<PageCapture> {
  const files: PageCapture = {
    html: join(outDir, "page.html"),
    screenshot: join(outDir, "screenshot.png"),
    meta: join(outDir, "meta.json"),
  };
  await writeFile(files.html, await page.content(), { mode: 0o600 });
  await page.screenshot({ path: files.screenshot, fullPage: true });
  await chmod(files.screenshot, 0o600);
  const meta = { url: page.url(), title: await page.title(), capturedAt: new Date().toISOString() };
  await writeFile(files.meta, JSON.stringify(meta, null, 2), { mode: 0o600 });
  return files;
}
