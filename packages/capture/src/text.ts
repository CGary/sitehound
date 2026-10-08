import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

export interface TextCapture {
  text: string;
  aria: string;
}

function bareUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return "";
  }
}

/**
 * Saves the page's visible text (`text.md`) and accessibility tree (`aria.yml`).
 * These are the compact, token-cheap views an agent should read instead of raw HTML.
 */
export async function captureText(page: Page, outDir: string): Promise<TextCapture> {
  const files: TextCapture = { text: join(outDir, "text.md"), aria: join(outDir, "aria.yml") };
  const body = await page.evaluate(() => document.body.innerText);
  const markdown = `# ${await page.title()}\n\n${bareUrl(page.url())}\n\n${body}\n`;
  await writeFile(files.text, markdown, { mode: 0o600 });
  await writeFile(files.aria, `${await page.locator("body").ariaSnapshot()}\n`, { mode: 0o600 });
  return files;
}
