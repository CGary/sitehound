import { capturePage, captureText } from "@sitehound/capture";
import { defineTask } from "@sitehound/core";

export default defineTask({
  name: "snapshot",
  description: "Full-page screenshot, rendered HTML, clean text, aria tree and metadata of a URL.",
  async run({ page, url, outDir, log, check }) {
    const response = await page.goto(url, { waitUntil: "networkidle" });
    check("navigation succeeded", response?.ok() ?? false, response ? `HTTP ${response.status()}` : "no response");
    const files = [...Object.values(await capturePage(page, outDir)), ...Object.values(await captureText(page, outDir))];
    log(`Saved ${files.length} files to ${outDir}`);
    return { summary: `Captured ${files.length} files`, data: { files: files.length } };
  },
});
