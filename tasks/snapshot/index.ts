import { capturePage } from "@sitehound/capture";
import { defineTask } from "@sitehound/core";

export default defineTask({
  name: "snapshot",
  description: "Full-page screenshot, rendered HTML and metadata of a URL.",
  async run({ page, url, outDir, log }) {
    await page.goto(url, { waitUntil: "networkidle" });
    const files = await capturePage(page, outDir);
    log(`Saved ${Object.values(files).length} files to ${outDir}`);
  },
});
