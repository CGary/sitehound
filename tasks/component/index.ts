import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { captureElement, type ElementState } from "@sitehound/capture";
import { defineTask, ensurePrivateDir } from "@sitehound/core";

const VALID_STATES: readonly ElementState[] = ["hover", "focus"];

function parseViewports(raw: string | boolean | undefined): number[] {
  const text = raw === undefined ? "1280" : raw;
  if (typeof text !== "string") throw new Error("--viewports needs a value, e.g. --viewports=375,768,1280");
  const widths = text.split(",").map((s) => s.trim());
  const out: number[] = [];
  for (const w of widths) {
    if (!/^\d+$/.test(w) || Number(w) <= 0) throw new Error(`Invalid viewport width "${w}": use positive integers`);
    if (!out.includes(Number(w))) out.push(Number(w));
  }
  return out;
}

function parseStates(raw: string | boolean | undefined): ElementState[] {
  if (raw === undefined) return [];
  if (typeof raw !== "string") throw new Error("--states needs a value, e.g. --states=hover,focus");
  const out: ElementState[] = [];
  for (const s of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (!VALID_STATES.includes(s as ElementState)) {
      throw new Error(`Invalid state "${s}": use ${VALID_STATES.join(", ")}`);
    }
    if (!out.includes(s as ElementState)) out.push(s as ElementState);
  }
  return out;
}

export default defineTask({
  name: "component",
  description:
    'Captures a UI component (screenshot, HTML, non-default computed styles, assets, hover/focus states) per viewport. Flags (use =): --selector="<css>" [--viewports=375,768,1280] [--states=hover,focus].',
  async run({ page, url, outDir, args, log }) {
    const selector = args.selector;
    if (typeof selector !== "string" || !selector.trim()) {
      throw new Error('Missing --selector="<css>" (the component to capture)');
    }
    const viewports = parseViewports(args.viewports);
    const states = parseStates(args.states);

    const files: Record<string, string[]> = {};
    for (const width of viewports) {
      log(`Viewport ${width}: loading`);
      await page.setViewportSize({ width, height: 900 });
      try {
        await page.goto(url, { waitUntil: "networkidle" });
      } catch (err) {
        if (!(err instanceof Error) || err.name !== "TimeoutError") throw err;
        log(`Viewport ${width}: networkidle timed out, falling back to load`);
        await page.goto(url, { waitUntil: "load" });
      }

      const dir = await ensurePrivateDir(join(outDir, String(width)));
      const pageShot = join(dir, "page.png");
      await page.screenshot({ path: pageShot, fullPage: true });
      await chmod(pageShot, 0o600);

      const cap = await captureElement(page, selector, outDir, { prefix: `${width}/`, states });
      files[String(width)] = [
        pageShot,
        cap.screenshot,
        cap.html,
        cap.styles,
        cap.assets,
        ...Object.values(cap.states).flatMap((s) => (s ? [s.screenshot, s.styles] : [])),
      ].map((f) => f.slice(outDir.length + 1));
      log(`Viewport ${width}: captured ${files[String(width)]?.length ?? 0} files`);
    }

    return {
      summary: `Captured component "${selector}" at ${viewports.join(", ")}px${states.length ? ` with states ${states.join(", ")}` : ""}`,
      data: { viewports, selector, states, files },
    };
  },
});
