import type { WaitFor } from "@sitehound/core";
import { FIND_CONTEXT_MAX, PDF_FORMATS, FIND_LIMIT_DEFAULT, FIND_LIMIT_MAX, FIND_PATTERN_MAX_CHARS } from "@sitehound/core/limits";
import { defineCommand } from "../framework/types.ts";
import type { NextAction } from "../framework/types.ts";
import { DIALOG_FLAGS, DIALOG_RULES, REF_RULE, SESSION_FLAG, VIEWPORT_DESCRIPTION, VIEWPORT_RULE, callSession, dialogData, dialogNote, dialogParams, sessionCmd, snapshotAction, viewportFlag } from "./browser-shared.ts";
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
    ...DIALOG_FLAGS,
  },
  requiresWhen: DIALOG_RULES,
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
      ...dialogParams(input),
    });
    return {
      summary: `Navigated to ${r.url}${r.status !== null ? ` (HTTP ${r.status})` : ""}.${dialogNote(r)}`,
      data: { url: r.url, title: r.title, status: r.status, ...dialogData(r) },
      next_actions: afterRead(s),
    };
  },
});

export const pageSnapshot = defineCommand({
  name: "page.snapshot",
  description:
    "Read the page as an accessibility tree with [ref=eN] element refs; large output is truncated and saved to a file. --ref reads only one element's subtree and --diff only what changed since the previous snapshot of the tab: both cut tokens on big pages.",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    ref: { type: "string", ...REF_RULE, description: "Snapshot only this element's subtree (a ref from an earlier snapshot, e.g. e12). Refs inside it are the same as in a full snapshot and work for element commands" },
    diff: {
      type: "boolean",
      description:
        "Return only the lines added (+) and removed (-) since the previous snapshot of this tab taken with the same --ref and --depth, as a unified diff (@@ hunks, 1 line of context, refs kept). The first call has no baseline: it returns the full snapshot (data.baseline false). Every snapshot, diff or not, becomes the new baseline. --limit-chars, --output and the saved file then hold the diff text",
    },
    depth: { type: "integer", min: 0, max: 1000, description: "Maximum tree depth (0 or omitted: unlimited)" },
    "limit-chars": { type: "integer", default: 8000, min: 1, max: 200000, description: "Max snapshot characters returned inline; the full text goes to a file when exceeded" },
    ...OUTPUT_FLAGS,
  },
  examples: [
    "hound page snapshot --session-name demo --json",
    "hound page snapshot --session-name demo --ref e12 --depth 4 --limit-chars 4000 --json",
    "hound page snapshot --session-name demo --diff --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    if (input.output) await checkOutputPath(this, givenInput(input, ctx), input.output, input["if-exists"]);
    const r = await callSession(ctx, s, "snapshot", {
      ...(input.depth !== undefined && { depth: input.depth }),
      limitChars: input["limit-chars"],
      ...(input.ref && { ref: input.ref }),
      ...(input.diff && { diff: true }),
      ...(input.output && { output: input.output, ifExists: input["if-exists"] }),
    });
    const next: NextAction[] = [
      { command: sessionCmd("element", "click", s, "--ref", "<ref>"), reason: "Click an element (replace <ref> with a ref from this snapshot, e.g. e12)." },
      { command: sessionCmd("element", "fill", s, "--ref", "<ref>", "--value", "<text>"), reason: "Fill a field (replace <ref> and <text>; needs --actions interact)." },
    ];
    if (r.file) next.push(readFileAction(r.file, r.truncated ? "Read the full snapshot." : "Read the saved snapshot."));
    const scope = input.ref ? `${input.ref} on ` : "";
    const d = r.diff;
    if (d?.baseline) {
      return {
        summary: d.added + d.removed === 0 ? `No changes in ${scope}${r.url} since the last snapshot.` : `Snapshot diff of ${scope}${r.url}: +${d.added} -${d.removed} lines${r.truncated ? " (truncated)" : ""}; ${r.refs} refs on the page.`,
        data: { url: r.url, title: r.title, refs: r.refs, truncated: r.truncated, totalChars: r.totalChars, ...(r.file && { file: r.file }), baseline: true, added: d.added, removed: d.removed, diff: r.snapshot },
        plain: r.snapshot || "No changes.",
        next_actions: next,
      };
    }
    return {
      summary: `Snapshot of ${scope}${r.url}: ${r.refs} refs, ${r.totalChars} chars${r.truncated ? " (truncated)" : ""}${d ? "; no earlier snapshot to compare with, this is the full snapshot" : ""}.`,
      data: {
        url: r.url,
        title: r.title,
        refs: r.refs,
        truncated: r.truncated,
        totalChars: r.totalChars,
        ...(r.file && { file: r.file }),
        ...(d && { baseline: false, added: d.added, removed: 0, diff: "" }),
        snapshot: r.snapshot,
      },
      plain: r.snapshot,
      next_actions: next,
    };
  },
});

export const pagePdf = defineCommand({
  name: "page.pdf",
  description: "Print the active tab to a PDF file and return its path (headless sessions only; uses the print stylesheet unless page emulate set screen). Default file in the session's runs directory (0600).",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    ...OUTPUT_FLAGS,
    output: { ...OUTPUT_FLAGS.output!, description: "Write the PDF to this file instead of the session's runs directory (relative paths resolve against the current directory; refuses directories and symlinks)" },
    format: { type: "enum", values: PDF_FORMATS, default: "A4", description: "Paper size" },
    landscape: { type: "boolean", description: "Landscape orientation (default portrait)" },
    background: { type: "boolean", description: "Print CSS backgrounds and background images (off by default, like a browser's print dialog)" },
  },
  examples: [
    "hound page pdf --session-name demo --json",
    "hound page pdf --session-name demo --format Letter --landscape --background --json",
    "hound page pdf --session-name demo --output ./invoice.pdf --if-exists overwrite --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    if (input.output) await checkOutputPath(this, givenInput(input, ctx), input.output, input["if-exists"]);
    const r = await callSession(ctx, s, "pdf", {
      format: input.format,
      ...(input.landscape && { landscape: true }),
      ...(input.background && { background: true }),
      ...(input.output && { output: input.output, ifExists: input["if-exists"] }),
    });
    return {
      summary: `Saved a ${r.format} PDF of ${r.url} (${r.bytes} bytes${r.pages !== undefined ? `, ${r.pages} page(s)` : ""}).`,
      data: { file: r.file, bytes: r.bytes, ...(r.pages !== undefined && { pages: r.pages }), format: r.format, landscape: r.landscape, background: r.background, url: r.url },
      plain: r.file,
      next_actions: afterRead(s),
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
      ...(input.output && { output: input.output, ifExists: input["if-exists"] }),
    });
    return {
      summary: `Saved ${r.scope} screenshot of ${r.url}.`,
      data: { file: r.file, scope: r.scope, url: r.url },
      plain: r.file,
      next_actions: afterRead(s),
    };
  },
});

export const pageResize = defineCommand({
  name: "page.resize",
  description: "Change the viewport of the active tab (other tabs keep theirs); layout, media queries and window.innerWidth follow. Returns the new size.",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    viewport: { type: "string", required: true, ...VIEWPORT_RULE, description: `New viewport, ${VIEWPORT_DESCRIPTION}` },
  },
  examples: [
    "hound page resize --session-name demo --viewport 375x812 --json",
    "hound page resize --session-name demo --viewport 1280x720 --json",
    "hound page resize --session-name demo --viewport 1920x1080 --plain",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const v = viewportFlag(input.viewport);
    const r = await callSession(ctx, s, "resize", v);
    return {
      summary: `Viewport is now ${r.viewport.width}x${r.viewport.height}.`,
      data: { viewport: r.viewport },
      plain: `${r.viewport.width}x${r.viewport.height}`,
      next_actions: [
        { command: sessionCmd("page", "screenshot", s), reason: "Capture the page at this size." },
        snapshotAction(s, "Read the page: responsive layouts may expose different elements (refs change)."),
      ],
    };
  },
});

export const pageEmulate = defineCommand({
  name: "page.emulate",
  description:
    "Emulate media features on the active tab: dark/light color scheme, print media, reduced motion. The settings are kept for the session and applied to tabs opened later; other open tabs are unchanged. Use --reset to clear all.",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    "color-scheme": { type: "enum", values: ["light", "dark", "no-preference"], description: "prefers-color-scheme" },
    media: { type: "enum", values: ["screen", "print"], description: "CSS media type (print shows the print stylesheet)" },
    "reduced-motion": { type: "enum", values: ["reduce", "no-preference"], description: "prefers-reduced-motion" },
    reset: { type: "boolean", description: "Clear every emulated setting (browser defaults); cannot be combined with the others" },
  },
  requiresAny: [["color-scheme", "media", "reduced-motion", "reset"]],
  requiresWhen: [{ when: { reset: true }, forbid: ["color-scheme", "media", "reduced-motion"] }],
  examples: [
    "hound page emulate --session-name demo --color-scheme dark --json",
    "hound page emulate --session-name demo --media print --reduced-motion reduce --json",
    "hound page emulate --session-name demo --reset --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "emulate", {
      ...(input["color-scheme"] && { colorScheme: input["color-scheme"] }),
      ...(input.media && { media: input.media }),
      ...(input["reduced-motion"] && { reducedMotion: input["reduced-motion"] }),
      ...(input.reset && { reset: true }),
    });
    return {
      summary: `Emulation: color-scheme ${r.colorScheme}, media ${r.media}, reduced-motion ${r.reducedMotion} ("default" = not emulated).`,
      data: { colorScheme: r.colorScheme, media: r.media, reducedMotion: r.reducedMotion },
      next_actions: [
        { command: sessionCmd("page", "screenshot", s), reason: "Capture the page with these settings." },
        { command: sessionCmd("page", "emulate", s, "--reset"), reason: "Clear the emulation." },
      ],
    };
  },
});

export const pageFind = defineCommand({
  name: "page.find",
  description:
    "Search the page for text without reading the whole snapshot: takes a fresh accessibility snapshot and returns only the matching lines with their [ref=...] and line numbers. The refs are valid for element commands. Cheaper than page snapshot on big pages.",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    text: { type: "string", maxLength: FIND_PATTERN_MAX_CHARS, description: `Substring to find, case-insensitive, at most ${FIND_PATTERN_MAX_CHARS} characters (values starting with '-' need --text=...)` },
    regex: {
      type: "string",
      maxLength: FIND_PATTERN_MAX_CHARS,
      description: `Regular expression, /pattern/flags (flags from i, m, s, u) or a bare pattern, at most ${FIND_PATTERN_MAX_CHARS} characters; only the first 2000 characters of each line are examined and a scan over 2 s is cancelled`,
    },
    limit: { type: "integer", default: FIND_LIMIT_DEFAULT, min: 1, max: FIND_LIMIT_MAX, description: "Max matches returned (the rest are counted in total)" },
    context: { type: "integer", default: 0, min: 0, max: FIND_CONTEXT_MAX, description: "Lines of snapshot to include before and after each match (their parents and children often hold the ref)" },
  },
  requires: [["text", "regex"]],
  examples: [
    'hound page find --session-name demo --text "add to cart" --json',
    'hound page find --session-name demo --regex "/^- (button|link) .*(buy|order)/i" --limit 10 --json',
    'hound page find --session-name demo --text "total" --context 2 --json',
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "find", {
      ...(input.text !== undefined && { text: input.text }),
      ...(input.regex !== undefined && { regex: input.regex }),
      limit: input.limit,
      context: input.context,
    });
    const firstRef = r.matches.find((m) => m.ref)?.ref;
    const next: NextAction[] = [];
    if (firstRef) {
      next.push({ command: sessionCmd("element", "click", s, "--ref", firstRef), reason: `Click the first match with a ref (${firstRef}); needs a link or --actions interact.` });
      next.push({ command: sessionCmd("element", "read", s, "--ref", firstRef), reason: "Read that element's text." });
    } else next.push(snapshotAction(s, r.total ? "Matches have no ref of their own: read the page around them (try --context)." : "No match: read the page."));
    if (r.snapshotFile) next.push(readFileAction(r.snapshotFile, "Read the full snapshot (matches were cut)."));
    return {
      summary: `${r.total} matching line(s) in ${r.url}${r.truncated ? `; ${r.matches.length} shown` : ""}${r.snapshotCut ? " (snapshot too large: only the first part was scanned)" : ""}.`,
      data: {
        url: r.url,
        title: r.title,
        matches: r.matches,
        total: r.total,
        truncated: r.truncated,
        lines: r.lines,
        ...(r.snapshotCut && { snapshotCut: true }),
        ...(r.snapshotFile && { snapshotFile: r.snapshotFile }),
      },
      plain: r.matches.map((m) => `${m.line}: ${m.text}`).join("\n") || "No matches.",
      next_actions: next.slice(0, 3),
    };
  },
});

const WAIT_FOR_VALUES: readonly WaitFor[] = ["text", "text-gone", "url", "ref", "ref-hidden", "request", "load"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export const pageWait = defineCommand({
  name: "page.wait",
  description:
    "Wait until text appears or disappears, the URL matches, an element is visible or hidden, a network request finishes, or the page finishes loading.",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    for: { type: "enum", values: WAIT_FOR_VALUES, required: true, description: "Condition to wait for" },
    value: {
      type: "string",
      maxLength: 2000,
      description:
        "text/text-gone: text to find (visible elements only); url: glob (with *) or substring; ref/ref-hidden: element ref (a ref no longer on the page counts as hidden); request: URL substring, or /regex/flags with flags only from i, m, s, u (pattern at most 200 characters, run with a time budget; anything else, like /api/ids, is a plain substring), matched against the request URL without query; load: optional load|domcontentloaded|networkidle (values starting with '-' need --value=...)",
    },
    within: { type: "string", ...REF_RULE, description: "text/text-gone only: limit the text search to this element ref (otherwise text anywhere on the page matches)" },
    method: { type: "enum", values: METHODS, description: "request only: HTTP method the request must have" },
    "since-index": {
      type: "integer",
      min: 0,
      max: 2147483647,
      description:
        "request only: match requests with an index (from diag network) greater than this. Default: the request counter when the last state-changing action of the session (click, fill, navigate, ...) started, so a fast request is not missed",
    },
  },
  requiresWhen: [
    { when: { for: ["text", "text-gone", "url", "ref", "ref-hidden", "request"] }, require: ["value"] },
    { when: { for: "load" }, restrict: { value: WAIT_UNTIL } },
    { when: { for: ["url", "ref", "ref-hidden", "request", "load"] }, forbid: ["within"] },
    { when: { for: ["text", "text-gone", "url", "ref", "ref-hidden", "load"] }, forbid: ["method", "since-index"] },
  ],
  examples: [
    'hound page wait --session-name demo --for text --value "Order confirmed" --json',
    'hound page wait --session-name demo --for text-gone --value "Cargando" --within e41 --timeout 30 --json',
    "hound page wait --session-name demo --for request --value /api/orders --method POST --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const cond: WaitFor = input.for;
    const r = await callSession(ctx, s, "wait", {
      for: cond,
      ...(input.value !== undefined && { value: input.value }),
      ...(input.within && { within: input.within }),
      ...(input.method && { method: input.method }),
      ...(input["since-index"] !== undefined && { sinceIndex: input["since-index"] }),
    });
    if (r.request) {
      const q = r.request;
      return {
        summary: `Request #${q.index} ${q.method} ${q.status ?? q.failure ?? "-"} ${q.url} matched after ${r.waitedMs} ms.${dialogNote(r)}`,
        data: {
          for: cond,
          waitedMs: r.waitedMs,
          sinceIndex: r.sinceIndex,
          index: q.index,
          method: q.method,
          ...(q.status !== undefined && { status: q.status }),
          ...(q.failure && { failure: q.failure }),
          url: q.url,
          ...dialogData(r),
        },
        next_actions: [
          { command: sessionCmd("diag", "request", s, "--index", String(q.index), "--part", "response-body"), reason: `Inspect the response body of request #${q.index} (redacted); use --part request-body for what was sent.` },
          snapshotAction(s, "Read the page after the request."),
        ],
      };
    }
    const neverThere = r.wasPresent === false ? ` The ${cond === "text-gone" ? "text" : "element"} was not present when the wait started: check the value.` : "";
    return {
      summary: `Condition "${cond}" met after ${r.waitedMs} ms.${neverThere}${dialogNote(r)}`,
      data: { for: cond, url: r.url, title: r.title, waitedMs: r.waitedMs, ...(r.wasPresent !== undefined && { wasPresent: r.wasPresent }), ...dialogData(r) },
      next_actions: afterRead(s),
    };
  },
});

function history(verb: "back" | "forward") {
  return defineCommand({
    name: `page.${verb}`,
    description: `Go ${verb} in the history of the active tab.`,
    kind: "write",
    flags: { ...SESSION_FLAG, ...DIALOG_FLAGS },
    requiresWhen: DIALOG_RULES,
    examples: [
      `hound page ${verb} --session-name demo --json`,
      `hound page ${verb} --session-name demo --timeout 20 --json`,
      `hound page ${verb} --session-name demo --plain`,
    ],
    async run(input, ctx) {
      const s: string = input["session-name"];
      const r = await callSession(ctx, s, verb, dialogParams(input));
      return {
        summary: `${r.moved ? `Went ${verb} to ${r.url}.` : `No history entry to go ${verb} to; still at ${r.url}.`}${dialogNote(r)}`,
        data: { moved: r.moved, url: r.url, title: r.title, ...dialogData(r) },
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
  flags: { ...SESSION_FLAG, ...DIALOG_FLAGS },
  requiresWhen: DIALOG_RULES,
  examples: [
    "hound page reload --session-name demo --json",
    "hound page reload --session-name demo --timeout 60 --json",
    "hound page reload --session-name demo --plain",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "reload", dialogParams(input));
    return {
      summary: `Reloaded ${r.url}${r.status !== null ? ` (HTTP ${r.status})` : ""}.${dialogNote(r)}`,
      data: { url: r.url, title: r.title, status: r.status, ...dialogData(r) },
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

export const pageCommands = [pageNavigate, pageSnapshot, pageFind, pageScreenshot, pagePdf, pageWait, pageBack, pageForward, pageReload, pageScroll, pageTabs, pageResize, pageEmulate];
