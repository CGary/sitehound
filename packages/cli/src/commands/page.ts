import { defineCommand } from "../framework/types.ts";
import type { NextAction } from "../framework/types.ts";
import { REF_RULE, SESSION_FLAG, callSession, sessionCmd, snapshotAction } from "./browser-shared.ts";
import { OUTPUT_FLAGS, checkOutputPath } from "./output.ts";
import { givenInput, parseUrlFlag, readFileAction } from "./shared.ts";

const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle"] as const;

/** Accepts http(s) URLs and about:blank (what the session allows). Returns the string to send. */
function checkUrl(field: string, value: string): string {
  return value === "about:blank" ? value : parseUrlFlag(field, value).href;
}

const afterRead = (s: string): NextAction[] => [snapshotAction(s, "Read the page and get element refs.")];

export const pageNavigate = defineCommand({
  name: "page.navigate",
  description: "Load a URL in the active tab of a session.",
  kind: "write",
  flags: {
    ...SESSION_FLAG,
    url: { type: "string", required: true, maxLength: 2048, description: "Absolute http(s) URL (or about:blank)" },
    "wait-until": { type: "enum", values: WAIT_UNTIL, default: "load", description: "Load event to wait for" },
  },
  examples: [
    "hound page navigate --session-name demo --url https://example.com --json",
    "hound page navigate --session-name demo --url https://example.com/app --wait-until networkidle --json",
    "hound page navigate --session-name demo --url https://example.com/docs --wait-until domcontentloaded --timeout 60 --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "navigate", {
      url: checkUrl("url", input.url),
      waitUntil: input["wait-until"],
    });
    return {
      summary: `Navigated to ${r.url}${r.status !== null ? ` (HTTP ${r.status})` : ""}.`,
      data: { url: r.url, title: r.title, status: r.status },
      next_actions: afterRead(s),
    };
  },
});

export const pageSnapshot = defineCommand({
  name: "page.snapshot",
  description: "Read the page as an accessibility tree with [ref=eN] element refs; large output is truncated and saved to a file.",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    depth: { type: "integer", min: 0, max: 1000, description: "Maximum tree depth (0 or omitted: unlimited)" },
    "limit-chars": { type: "integer", default: 8000, min: 1, max: 200000, description: "Max snapshot characters returned inline; the full text goes to a file when exceeded" },
    ...OUTPUT_FLAGS,
  },
  examples: [
    "hound page snapshot --session-name demo --json",
    "hound page snapshot --session-name demo --depth 4 --limit-chars 4000 --json",
    "hound page snapshot --session-name demo --output ./page.yml --if-exists overwrite --limit-chars 2000 --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    if (input.output) await checkOutputPath(this, givenInput(input, ctx), input.output, input["if-exists"]);
    const r = await callSession(ctx, s, "snapshot", {
      ...(input.depth !== undefined && { depth: input.depth }),
      limitChars: input["limit-chars"],
      ...(input.output && { output: input.output }),
    });
    const next: NextAction[] = [
      { command: sessionCmd("element", "click", s, "--ref", "<ref>"), reason: "Click an element (replace <ref> with a ref from this snapshot, e.g. e12)." },
      { command: sessionCmd("element", "fill", s, "--ref", "<ref>", "--value", "<text>"), reason: "Fill a field (replace <ref> and <text>; needs --actions interact)." },
    ];
    if (r.file) next.push(readFileAction(r.file, r.truncated ? "Read the full snapshot." : "Read the saved snapshot."));
    return {
      summary: `Snapshot of ${r.url}: ${r.refs} refs, ${r.totalChars} chars${r.truncated ? " (truncated)" : ""}.`,
      data: {
        url: r.url,
        title: r.title,
        refs: r.refs,
        truncated: r.truncated,
        totalChars: r.totalChars,
        ...(r.file && { file: r.file }),
        snapshot: r.snapshot,
      },
      plain: r.snapshot,
      next_actions: next,
    };
  },
});

export const pageScreenshot = defineCommand({
  name: "page.screenshot",
  description: "Save a PNG screenshot of the viewport, the full page, or one element, and return its path.",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    scope: { type: "enum", values: ["viewport", "full", "element"], default: "viewport", description: "What to capture; element needs --ref" },
    ref: { type: "string", ...REF_RULE, description: "Element ref from the latest snapshot, e.g. e12 or f3e4 (only with --scope element)" },
    ...OUTPUT_FLAGS,
    output: { ...OUTPUT_FLAGS.output!, description: "Write the PNG to this file instead of the session's runs directory (relative paths resolve against the current directory; refuses directories and symlinks)" },
  },
  requiresWhen: [
    { when: { scope: "element" }, require: ["ref"] },
    { when: { scope: ["viewport", "full"] }, forbid: ["ref"] },
  ],
  examples: [
    "hound page screenshot --session-name demo --json",
    "hound page screenshot --session-name demo --scope full --output ./home.png --json",
    "hound page screenshot --session-name demo --scope element --ref e12 --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    if (input.output) await checkOutputPath(this, givenInput(input, ctx), input.output, input["if-exists"]);
    const r = await callSession(ctx, s, "screenshot", {
      scope: input.scope,
      ...(input.ref && { ref: input.ref }),
      ...(input.output && { output: input.output }),
    });
    return {
      summary: `Saved ${r.scope} screenshot of ${r.url}.`,
      data: { file: r.file, scope: r.scope, url: r.url },
      plain: r.file,
      next_actions: afterRead(s),
    };
  },
});

export const pageWait = defineCommand({
  name: "page.wait",
  description: "Wait until text appears, the URL matches, an element is visible, or the page finishes loading.",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    for: { type: "enum", values: ["text", "url", "ref", "load"], required: true, description: "Condition to wait for" },
    value: { type: "string", maxLength: 2000, description: "text: text to find; url: glob (with *) or substring; ref: element ref; load: optional load|domcontentloaded|networkidle (values starting with '-' need --value=...)" },
  },
  requiresWhen: [
    { when: { for: ["text", "url", "ref"] }, require: ["value"] },
    { when: { for: "load" }, restrict: { value: WAIT_UNTIL } },
  ],
  examples: [
    'hound page wait --session-name demo --for text --value "Order confirmed" --json',
    "hound page wait --session-name demo --for url --value '**/dashboard' --timeout 30 --json",
    "hound page wait --session-name demo --for load --value networkidle --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const cond: "text" | "url" | "ref" | "load" = input.for;
    const r = await callSession(ctx, s, "wait", {
      for: cond,
      ...(input.value !== undefined && { value: input.value }),
    });
    return {
      summary: `Condition "${cond}" met after ${r.waitedMs} ms.`,
      data: { for: cond, url: r.url, title: r.title, waitedMs: r.waitedMs },
      next_actions: afterRead(s),
    };
  },
});

function history(verb: "back" | "forward") {
  return defineCommand({
    name: `page.${verb}`,
    description: `Go ${verb} in the history of the active tab.`,
    kind: "write",
    flags: { ...SESSION_FLAG },
    examples: [
      `hound page ${verb} --session-name demo --json`,
      `hound page ${verb} --session-name demo --timeout 20 --json`,
      `hound page ${verb} --session-name demo --plain`,
    ],
    async run(input, ctx) {
      const s: string = input["session-name"];
      const r = await callSession(ctx, s, verb, {});
      return {
        summary: r.moved ? `Went ${verb} to ${r.url}.` : `No history entry to go ${verb} to; still at ${r.url}.`,
        data: { moved: r.moved, url: r.url, title: r.title },
        next_actions: afterRead(s),
      };
    },
  });
}

export const pageBack = history("back");
export const pageForward = history("forward");

export const pageReload = defineCommand({
  name: "page.reload",
  description: "Reload the active tab.",
  kind: "write",
  flags: { ...SESSION_FLAG },
  examples: [
    "hound page reload --session-name demo --json",
    "hound page reload --session-name demo --timeout 60 --json",
    "hound page reload --session-name demo --plain",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "reload", {});
    return {
      summary: `Reloaded ${r.url}${r.status !== null ? ` (HTTP ${r.status})` : ""}.`,
      data: { url: r.url, title: r.title, status: r.status },
      next_actions: afterRead(s),
    };
  },
});

export const pageScroll = defineCommand({
  name: "page.scroll",
  description: "Scroll the active page by a page, half a page, or to the top/bottom.",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    direction: { type: "enum", values: ["up", "down"], required: true, description: "Scroll direction (ignored for top/bottom)" },
    amount: { type: "enum", values: ["page", "half", "top", "bottom"], required: true, description: "How far to scroll" },
  },
  examples: [
    "hound page scroll --session-name demo --direction down --amount page --json",
    "hound page scroll --session-name demo --direction up --amount half --json",
    "hound page scroll --session-name demo --direction down --amount bottom --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "scroll", { direction: input.direction, amount: input.amount });
    const where = input.amount === "top" || input.amount === "bottom" ? `to the ${input.amount}` : `${input.direction} ${input.amount === "half" ? "half a page" : "a page"}`;
    return {
      summary: `Scrolled ${where} (y=${r.scrollY} of ${r.scrollHeight}).`,
      data: { scrollY: r.scrollY, scrollHeight: r.scrollHeight, viewportHeight: r.viewportHeight },
      next_actions: afterRead(s),
    };
  },
});

export const pageTabs = defineCommand({
  name: "page.tabs",
  description: "List, select, close or open browser tabs of a session.",
  kind: "write",
  flags: {
    ...SESSION_FLAG,
    action: { type: "enum", values: ["list", "select", "close", "new"], required: true, description: "What to do: list; select/close need --tab-index; new needs --url" },
    "tab-index": { type: "integer", min: 0, max: 1000, description: "Tab index from the list (required for select and close)" },
    url: { type: "string", maxLength: 2048, description: "URL to open in the new tab (required for new)" },
  },
  requiresWhen: [
    { when: { action: "new" }, require: ["url"] },
    { when: { action: ["select", "close"] }, require: ["tab-index"] },
  ],
  examples: [
    "hound page tabs --session-name demo --action list --json",
    "hound page tabs --session-name demo --action new --url https://example.com --json",
    "hound page tabs --session-name demo --action select --tab-index 0 --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const action: "list" | "select" | "close" | "new" = input.action;
    const r = await callSession(ctx, s, "tabs", {
      action,
      ...(input["tab-index"] !== undefined && { tabIndex: input["tab-index"] }),
      ...(input.url && { url: checkUrl("url", input.url) }),
    });
    return {
      summary: {
        list: `${r.tabs.length} tab(s) open; active is ${r.active}.`,
        select: `Selected tab ${r.active}.`,
        close: `Closed a tab; ${r.tabs.length} open, active is ${r.active}.`,
        new: `Opened a new tab; ${r.tabs.length} open, active is ${r.active}.`,
      }[action],
      data: { count: r.tabs.length, active: r.active, tabs: r.tabs },
      plain: r.tabs.map((t) => `${t.active ? "*" : " "} ${t.index} ${t.url} ${t.title}`).join("\n"),
      next_actions: afterRead(s),
    };
  },
});

export const pageCommands = [pageNavigate, pageSnapshot, pageScreenshot, pageWait, pageBack, pageForward, pageReload, pageScroll, pageTabs];
