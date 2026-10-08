import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { HoundError } from "@sitehound/core/errors";
import { MAX_OP_TIMEOUT_MS, TYPE_MAX_CHARS, TYPING_BASE_MS, TYPING_EXTRA_MS_PER_KEY } from "@sitehound/core/limits";
import { defineCommand } from "../framework/types.ts";
import { checkCostRules, checkMaxChars } from "../framework/rules.ts";
import type { FlagSpec } from "../framework/types.ts";
import { REF_RULE, SESSION_FLAG, callSession, scrubSecret, snapshotAction } from "./browser-shared.ts";
import { OUTPUT_FLAGS, checkOutputPath } from "./output.ts";
import { givenInput } from "./shared.ts";

const REF_FLAG: FlagSpec = { type: "string", required: true, ...REF_RULE, description: "Element ref from the latest page snapshot, e.g. e12 or f3e4" };
const MAX_VALUE_BYTES = 1_000_000;

const afterAct = (s: string) => [snapshotAction(s, "Read the page after the action.")];

export const elementClick = defineCommand({
  name: "element.click",
  description: "Click an element by ref. The read level only clicks real http(s) links and <summary> (GET links with side effects, e.g. /logout, are not detected); everything else needs --actions interact.",
  kind: "write",
  flags: { ...SESSION_FLAG, ref: REF_FLAG },
  examples: [
    "hound element click --session-name demo --ref e12 --json",
    "hound element click --session-name demo --ref e7 --timeout 20 --json",
    "hound element click --session-name work --ref e31 --plain",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "click", { ref: input.ref });
    return {
      summary: `Clicked ${r.ref}; now at ${r.url}.`,
      data: { ref: r.ref, url: r.url, title: r.title, tabs: r.tabs },
      next_actions: afterAct(s),
    };
  },
});

export const elementHover = defineCommand({
  name: "element.hover",
  description: "Move the pointer over an element by ref (reveals menus and tooltips).",
  kind: "read",
  flags: { ...SESSION_FLAG, ref: REF_FLAG },
  examples: [
    "hound element hover --session-name demo --ref e5 --json",
    "hound element hover --session-name demo --ref e18 --timeout 15 --json",
    "hound element hover --session-name work --ref e3 --plain",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "hover", { ref: input.ref });
    return { summary: `Hovered ${r.ref}.`, data: { ref: r.ref }, next_actions: afterAct(s) };
  },
});

/** Reads the fill value from --value or --value-file (`-` = stdin). One trailing newline is dropped. */
async function readValue(input: Record<string, unknown>): Promise<string> {
  if (typeof input.value === "string") return input.value;
  const file = input["value-file"] as string;
  let text: string;
  if (file === "-") {
    if (process.stdin.isTTY) {
      throw new HoundError("INVALID_ARGUMENT", "--value-file - reads stdin, but stdin is a terminal. Pipe the value in.", {
        field: "value-file",
        received: "-",
        retryable: true,
      });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_VALUE_BYTES) throw tooLarge();
      chunks.push(buf);
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else {
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new HoundError("FILE_NOT_FOUND", `Value file not found: ${file}`, { field: "value-file", received: file, retryable: true });
    }
    if (statSync(file).size > MAX_VALUE_BYTES) throw tooLarge();
    text = await readFile(file, "utf8");
  }
  return text.replace(/\r?\n$/, "");
}

const tooLarge = () =>
  new HoundError("INVALID_ARGUMENT", `The value is larger than ${MAX_VALUE_BYTES} bytes.`, { field: "value-file", retryable: false });

export const elementFill = defineCommand({
  name: "element.fill",
  description: "Replace the text of an input/textarea by ref. Needs a session opened with --actions interact. The value is never echoed.",
  kind: "write",
  flags: {
    ...SESSION_FLAG,
    ref: REF_FLAG,
    value: { type: "string", sensitive: true, description: "Text to type (appears in process lists; prefer --value-file for secrets; a value starting with '-' must be passed as --value=...)" },
    "value-file": { type: "path", sensitive: true, description: "File with the text to type, or - for stdin (one trailing newline is removed)" },
  },
  requires: [["value", "value-file"]],
  examples: [
    'hound element fill --session-name demo --ref e5 --value "jane@example.com" --json',
    "hound element fill --session-name demo --ref e9 --value-file ./message.txt --json",
    "printf '%s' \"$PASSWORD\" | hound element fill --session-name demo --ref e6 --value-file - --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const value = await readValue(input);
    try {
      const r = await callSession(ctx, s, "fill", { ref: input.ref, value });
      return {
        summary: `Filled ${r.ref} (${r.chars} chars).`,
        data: { ref: r.ref, chars: r.chars },
        next_actions: afterAct(s),
      };
    } catch (err) {
      return scrubSecret(err, value);
    }
  },
});

export const elementType = defineCommand({
  name: "element.type",
  description:
    "Type text into an element character by character with real key events (keydown/keypress/keyup), for search-as-you-type fields and comboboxes where fill shows nothing. Needs --actions interact. The value is never echoed.",
  kind: "write",
  flags: {
    ...SESSION_FLAG,
    ref: REF_FLAG,
    value: { type: "string", sensitive: true, maxLength: TYPE_MAX_CHARS, description: `Text to type, at most ${TYPE_MAX_CHARS} characters (appears in process lists; prefer --value-file for secrets; a value starting with '-' must be passed as --value=...)` },
    "value-file": { type: "path", sensitive: true, maxChars: TYPE_MAX_CHARS, description: `File with the text to type, or - for stdin (one trailing newline is removed; at most ${TYPE_MAX_CHARS} characters)` },
    "delay-ms": { type: "integer", default: 30, min: 0, max: 1000, description: "Pause between key presses in milliseconds; the typing time must fit in one operation (see cost_rules in --schema)" },
    clear: { type: "boolean", description: "Empty the field first (fill with empty text, or select-all + Backspace for elements that are not inputs)" },
  },
  requires: [["value", "value-file"]],
  costRules: [{ text: ["value", "value-file"], perChar: "delay-ms", extraMs: TYPING_EXTRA_MS_PER_KEY, baseMs: TYPING_BASE_MS, maxMs: MAX_OP_TIMEOUT_MS }],
  examples: [
    'hound element type --session-name demo --ref e5 --value "mar" --json',
    'hound element type --session-name demo --ref e5 --value "Madrid" --clear --delay-ms 80 --json',
    "hound element type --session-name demo --ref e9 --value-file ./query.txt --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const value = await readValue(input);
    if (typeof input["value-file"] === "string") checkMaxChars(this, "value-file", value.length);
    const delay: number = input["delay-ms"];
    checkCostRules(this, input, givenInput(input, ctx), value.length);
    try {
      const r = await callSession(ctx, s, "type", {
        ref: input.ref,
        value,
        delayMs: delay,
        ...(input.clear && { clear: true }),
      });
      return {
        summary: `Typed ${r.chars} chars into ${r.ref}.`,
        data: { ref: r.ref, chars: r.chars },
        next_actions: [snapshotAction(s, "Read the page: suggestions or options may have appeared (refs change).")],
      };
    } catch (err) {
      return scrubSecret(err, value);
    }
  },
});

export const elementDownload = defineCommand({
  name: "element.download",
  description:
    "Click an element (usually a download link or button) and save the file it downloads; returns the path, never the contents. The read level only allows real http(s) links; buttons need --actions interact. Waits for the download up to --timeout (default 30 s).",
  kind: "write",
  flags: {
    ...SESSION_FLAG,
    ref: REF_FLAG,
    ...OUTPUT_FLAGS,
    output: { ...OUTPUT_FLAGS.output!, description: "Save the file here instead of the session's downloads directory (relative paths resolve against the current directory; refuses directories and symlinks)" },
  },
  examples: [
    "hound element download --session-name demo --ref e12 --json",
    "hound element download --session-name demo --ref e12 --output ./report.pdf --json",
    "hound element download --session-name demo --ref e12 --output ./report.pdf --if-exists overwrite --timeout 60 --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    if (input.output) await checkOutputPath(this, givenInput(input, ctx), input.output, input["if-exists"]);
    const r = await callSession(ctx, s, "download", { ref: input.ref, ...(input.output && { output: input.output, ifExists: input["if-exists"] }) });
    return {
      summary: `Downloaded ${r.suggestedFilename} (${r.bytes} bytes).`,
      data: { file: r.file, bytes: r.bytes, suggestedFilename: r.suggestedFilename, url: r.url },
      plain: r.file,
      next_actions: [snapshotAction(s, "Read the page after the click.")],
    };
  },
});

export const elementSelect = defineCommand({
  name: "element.select",
  description: "Choose option(s) in a <select> by ref, matching by value or label. Needs --actions interact.",
  kind: "write",
  flags: {
    ...SESSION_FLAG,
    ref: REF_FLAG,
    option: { type: "string", required: true, repeatable: true, maxLength: 1000, description: "Option value or label; required at least once, repeat for multi-selects" },
  },
  examples: [
    "hound element select --session-name demo --ref e8 --option small --json",
    'hound element select --session-name demo --ref e8 --option "Extra large" --json',
    "hound element select --session-name demo --ref e11 --option red --option blue --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "select", { ref: input.ref, options: input.option });
    return {
      summary: `Selected ${r.selected.length} option(s) in ${r.ref}.`,
      data: { ref: r.ref, selected: r.selected },
      next_actions: afterAct(s),
    };
  },
});

export const elementPress = defineCommand({
  name: "element.press",
  description: "Press a key (Playwright names: Enter, Escape, Tab, Control+A) on an element, or on the focused one. Needs --actions interact.",
  kind: "write",
  flags: {
    ...SESSION_FLAG,
    key: { type: "string", required: true, maxLength: 100, description: "Playwright key name, e.g. Enter, Escape, ArrowDown, Control+A" },
    ref: { type: "string", ...REF_RULE, description: "Element ref to focus first, e.g. e12 (default: the focused element)" },
  },
  examples: [
    "hound element press --session-name demo --key Enter --json",
    "hound element press --session-name demo --key Escape --ref e4 --json",
    "hound element press --session-name demo --key Control+A --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "press", { key: input.key, ...(input.ref && { ref: input.ref }) });
    return {
      summary: `Pressed ${r.key}; now at ${r.url}.`,
      data: { key: r.key, url: r.url, title: r.title },
      next_actions: afterAct(s),
    };
  },
});

export const elementCommands = [elementClick, elementHover, elementFill, elementType, elementSelect, elementPress, elementDownload];
