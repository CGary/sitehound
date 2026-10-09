import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ClickModifier } from "@sitehound/core";
import { HoundError } from "@sitehound/core/errors";
import { ATTR_NAME_PATTERN, DRAG_METHODS, DRAG_STEPS_DEFAULT, DRAG_STEPS_MAX, DRAG_STEPS_MIN, MAX_OP_TIMEOUT_MS, READ_LIMIT_DEFAULT, READ_LIMIT_MAX, TYPE_MAX_CHARS, TYPING_BASE_MS, TYPING_EXTRA_MS_PER_KEY, UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES } from "@sitehound/core/limits";
import { defineCommand } from "../framework/types.ts";
import { checkCostRules, checkMaxChars } from "../framework/rules.ts";
import type { FlagSpec } from "../framework/types.ts";
import { DIALOG_FLAGS, DIALOG_RULES, REF_RULE, SESSION_FLAG, callSession, dialogData, dialogNote, dialogParams, scrubSecret, snapshotAction } from "./browser-shared.ts";
import { OUTPUT_FLAGS, checkOutputPath } from "./output.ts";
import { givenInput } from "./shared.ts";

const REF_FLAG: FlagSpec = { type: "string", required: true, ...REF_RULE, description: "Element ref from the latest page snapshot, e.g. e12 or f3e4" };
const MAX_VALUE_BYTES = 1_000_000;

const afterAct = (s: string) => [snapshotAction(s, "Read the page after the action.")];

const MODIFIER_NAMES = "Alt|Control|ControlOrMeta|Meta|Shift";

export const elementClick = defineCommand({
  name: "element.click",
  description:
    "Click an element by ref. The read level only clicks real http(s) links and <summary> with a plain single left click, and refuses links that look like GET side effects (e.g. /logout, or sign out, delete, remove, unsubscribe, cerrar sesión, eliminar in the URL path, query or link text: ACTION_BLOCKED); everything else, including --count/--button/--modifiers, needs --actions interact.",
  kind: "write",
  flags: {
    ...SESSION_FLAG,
    ref: REF_FLAG,
    count: { type: "integer", min: 1, max: 3, description: "Click count: 2 = double click, 3 = triple click (default 1; needs --actions interact when above 1)" },
    button: { type: "enum", values: ["left", "right", "middle"], description: "Mouse button (default left; right and middle need --actions interact)" },
    modifiers: {
      type: "string",
      pattern: `^(?:${MODIFIER_NAMES})(?:,(?:${MODIFIER_NAMES}))*$`,
      patternHint: "a comma list of Alt, Control, ControlOrMeta, Meta, Shift, e.g. Control,Shift",
      maxLength: 80,
      description: "Keys held during the click, comma list of Alt, Control, ControlOrMeta, Meta, Shift (needs --actions interact)",
    },
    ...DIALOG_FLAGS,
  },
  requiresWhen: DIALOG_RULES,
  examples: [
    "hound element click --session-name demo --ref e12 --json",
    "hound element click --session-name demo --ref e7 --dialog accept --timeout 20 --json",
    "hound element click --session-name work --ref e31 --count 2 --button right --modifiers Shift --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const modifiers = typeof input.modifiers === "string" ? input.modifiers.split(",") : undefined;
    const r = await callSession(ctx, s, "click", {
      ref: input.ref,
      ...(input.count !== undefined && { count: input.count }),
      ...(input.button !== undefined && { button: input.button }),
      ...(modifiers && { modifiers: modifiers as ClickModifier[] }),
      ...dialogParams(input),
    });
    return {
      summary: `Clicked ${r.ref}; now at ${r.url}.${dialogNote(r)}`,
      data: {
        ref: r.ref,
        url: r.url,
        title: r.title,
        tabs: r.tabs,
        ...(r.count !== undefined && { count: r.count }),
        ...(r.button !== undefined && { button: r.button }),
        ...(r.modifiers && { modifiers: r.modifiers }),
        ...dialogData(r),
      },
      next_actions: afterAct(s),
    };
  },
});

export const elementDrag = defineCommand({
  name: "element.drag",
  description:
    "Drag an element onto another by ref. --method auto (default) tries HTML5 drag-and-drop first (pointer down, one move, release) and, when the page did not react or that failed, repeats with a real pointer path of --steps intermediate moves, for libraries that need them (data.method says which ran). Needs --actions interact. Check the page afterwards: a page that reacts in ways sitehound cannot see may be dragged twice.",
  kind: "write",
  flags: {
    ...SESSION_FLAG,
    ref: { ...REF_FLAG, description: "Source element ref (what is dragged), e.g. e12" },
    "to-ref": { type: "string", required: true, ...REF_RULE, description: "Target element ref (where it is dropped), e.g. e30" },
    method: {
      type: "enum",
      values: DRAG_METHODS,
      default: "auto",
      description: "auto: HTML5 drag-and-drop first, a real pointer path when the page did not react; html5: only drag-and-drop; mouse: only the pointer path (move to the source, press, --steps moves to the target, release)",
    },
    steps: { type: "integer", default: DRAG_STEPS_DEFAULT, min: DRAG_STEPS_MIN, max: DRAG_STEPS_MAX, description: "Pointer moves between source and target on the pointer path (--method mouse, or auto when it falls back)" },
    ...DIALOG_FLAGS,
  },
  requiresWhen: DIALOG_RULES,
  examples: [
    "hound element drag --session-name demo --ref e12 --to-ref e30 --json",
    "hound element drag --session-name demo --ref e4 --to-ref e9 --dialog accept --json",
    "hound element drag --session-name work --ref e7 --to-ref e8 --method mouse --steps 20 --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "drag", { ref: input.ref, toRef: input["to-ref"], method: input.method, steps: input.steps, ...dialogParams(input) });
    return {
      summary: `Dragged ${r.ref} onto ${r.toRef} (${r.method}${r.fellBack ? ", after drag-and-drop had no effect" : ""}); now at ${r.url}.${dialogNote(r)}`,
      data: { ref: r.ref, toRef: r.toRef, method: r.method, ...(r.fellBack && { fellBack: true }), url: r.url, title: r.title, tabs: r.tabs, ...dialogData(r) },
      next_actions: afterAct(s),
    };
  },
});

function setChecked(verb: "check" | "uncheck") {
  const on = verb === "check";
  return defineCommand({
    name: `element.${verb}`,
    description: `${on ? "Check" : "Uncheck"} a checkbox, radio button or switch by ref (<input type=checkbox|radio>, or role checkbox, radio or switch with aria-checked). Idempotent: when it already is ${on ? "checked" : "unchecked"} nothing is clicked (data.changed false). ${on ? "" : "A radio button cannot be unchecked. "}Needs --actions interact (it changes form state).`,
    kind: "write",
    flags: { ...SESSION_FLAG, ref: { ...REF_FLAG, description: "Checkbox, radio or switch ref from the latest page snapshot, e.g. e12" }, ...DIALOG_FLAGS },
    requiresWhen: DIALOG_RULES,
    examples: [
      `hound element ${verb} --session-name work --ref e12 --json`,
      `hound element ${verb} --session-name work --ref e31 --timeout 20 --json`,
      `hound element ${verb} --session-name work --ref e7 --dialog accept --json`,
    ],
    async run(input, ctx) {
      const s: string = input["session-name"];
      const r = await callSession(ctx, s, "check", { ref: input.ref, checked: on, ...dialogParams(input) });
      return {
        summary: `${r.changed ? `${r.checked ? "Checked" : "Unchecked"} ${r.ref}` : `${r.ref} was already ${r.checked ? "checked" : "unchecked"}; nothing changed`}.${dialogNote(r)}`,
        data: { ref: r.ref, checked: r.checked, changed: r.changed, ...dialogData(r) },
        next_actions: afterAct(s),
      };
    },
  });
}

export const elementCheck = setChecked("check");
export const elementUncheck = setChecked("uncheck");

export const elementRead = defineCommand({
  name: "element.read",
  description:
    "Read one element: its text (innerText) or one attribute, without a full snapshot. Tokens are masked and URL attributes (href, src, action, formaction, data-*url*) lose their query and fragment. Password fields yield no text and only descriptive attributes (ACTION_BLOCKED otherwise). --attr value on a form field returns its current value.",
  kind: "read",
  flags: {
    ...SESSION_FLAG,
    ref: REF_FLAG,
    attr: { type: "string", pattern: ATTR_NAME_PATTERN, patternHint: "an attribute name such as href, value or aria-label", maxLength: 64, description: "Attribute to read instead of the text, e.g. href, src, value, aria-label" },
    "limit-chars": { type: "integer", default: READ_LIMIT_DEFAULT, min: 1, max: READ_LIMIT_MAX, description: "Max characters returned (data.chars is the full length; data.truncated tells if it was cut)" },
  },
  examples: [
    "hound element read --session-name demo --ref e12 --json",
    "hound element read --session-name demo --ref e12 --attr href --json",
    "hound element read --session-name demo --ref e5 --attr value --limit-chars 500 --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "read", { ref: input.ref, ...(input.attr && { attr: input.attr }), limitChars: input["limit-chars"] });
    const shown = r.attr !== undefined ? r.value : r.text;
    return {
      summary:
        r.attr !== undefined
          ? r.value === null
            ? `${r.ref} has no "${r.attr}" attribute.`
            : `Read ${r.attr} of ${r.ref} (${r.chars} chars${r.truncated ? ", truncated" : ""}).`
          : `Read the text of ${r.ref} (${r.chars} chars${r.truncated ? ", truncated" : ""}).`,
      data: {
        ref: r.ref,
        ...(r.attr !== undefined && { attr: r.attr }),
        ...(r.attr !== undefined ? { value: r.value } : { text: r.text }),
        chars: r.chars,
        truncated: r.truncated,
      },
      plain: shown ?? "",
      next_actions: [snapshotAction(s, "Read the page.")],
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
    return { summary: `Hovered ${r.ref}.${dialogNote(r)}`, data: { ref: r.ref, ...dialogData(r) }, next_actions: afterAct(s) };
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
        summary: `Filled ${r.ref} (${r.chars} chars).${dialogNote(r)}`,
        data: { ref: r.ref, chars: r.chars, ...dialogData(r) },
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
    ...DIALOG_FLAGS,
  },
  requires: [["value", "value-file"]],
  requiresWhen: DIALOG_RULES,
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
        ...dialogParams(input),
      });
      return {
        summary: `Typed ${r.chars} chars into ${r.ref}.${dialogNote(r)}`,
        data: { ref: r.ref, chars: r.chars, ...dialogData(r) },
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
    "Click an element (usually a download link or button) and save the file it downloads; returns the path, never the contents. The read level only allows real http(s) links that do not look like side-effect links (same rule as click); buttons need --actions interact. Waits for the download up to --timeout (default 30 s).",
  kind: "write",
  flags: {
    ...SESSION_FLAG,
    ref: REF_FLAG,
    ...OUTPUT_FLAGS,
    output: { ...OUTPUT_FLAGS.output!, description: "Save the file here instead of the session's downloads directory (relative paths resolve against the current directory; refuses directories and symlinks)" },
    ...DIALOG_FLAGS,
  },
  requiresWhen: DIALOG_RULES,
  examples: [
    "hound element download --session-name demo --ref e12 --json",
    "hound element download --session-name demo --ref e12 --output ./report.pdf --json",
    "hound element download --session-name demo --ref e12 --output ./report.pdf --if-exists overwrite --timeout 60 --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    if (input.output) await checkOutputPath(this, givenInput(input, ctx), input.output, input["if-exists"]);
    const r = await callSession(ctx, s, "download", { ref: input.ref, ...(input.output && { output: input.output, ifExists: input["if-exists"] }), ...dialogParams(input) });
    return {
      summary: `Downloaded ${r.suggestedFilename} (${r.bytes} bytes).${dialogNote(r)}`,
      data: { file: r.file, bytes: r.bytes, suggestedFilename: r.suggestedFilename, url: r.url, ...dialogData(r) },
      plain: r.file,
      next_actions: [snapshotAction(s, "Read the page after the click.")],
    };
  },
});

export const elementUpload = defineCommand({
  name: "element.upload",
  description: `Attach local files to a file field by ref: an <input type=file> directly, or a button/label that opens the file chooser (it is clicked). Needs --actions interact. Upload only files the user named: sitehound's own data (.hound), .env files, HAR/trace files, SSH/cloud credentials and key files are refused (ACTION_BLOCKED). At most ${UPLOAD_MAX_FILES} regular files, ${UPLOAD_MAX_BYTES / (1024 * 1024)} MiB in total. Returns file names and sizes only.`,
  kind: "write",
  flags: {
    ...SESSION_FLAG,
    ref: REF_FLAG,
    file: { type: "path", required: true, repeatable: true, maxLength: 4096, description: `File to upload (relative paths resolve against the current directory); repeat for several files, at most ${UPLOAD_MAX_FILES}` },
    ...DIALOG_FLAGS,
  },
  requiresWhen: DIALOG_RULES,
  examples: [
    "hound element upload --session-name demo --ref e9 --file ./invoice.pdf --json",
    "hound element upload --session-name demo --ref e9 --file ./a.png --file ./b.png --json",
    "hound element upload --session-name demo --ref e14 --file ./data.csv --timeout 20 --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "upload", { ref: input.ref, files: input.file, ...dialogParams(input) });
    return {
      summary: `Attached ${r.files.length} file(s) to ${r.ref}.${dialogNote(r)}`,
      data: { ref: r.ref, files: r.files, ...dialogData(r) },
      plain: r.files.map((f) => `${f.name} ${f.bytes}`).join("\n"),
      next_actions: afterAct(s),
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
    ...DIALOG_FLAGS,
  },
  requiresWhen: DIALOG_RULES,
  examples: [
    "hound element select --session-name demo --ref e8 --option small --json",
    'hound element select --session-name demo --ref e8 --option "Extra large" --json',
    "hound element select --session-name demo --ref e11 --option red --option blue --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "select", { ref: input.ref, options: input.option, ...dialogParams(input) });
    return {
      summary: `Selected ${r.selected.length} option(s) in ${r.ref}.${dialogNote(r)}`,
      data: { ref: r.ref, selected: r.selected, ...dialogData(r) },
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
    ...DIALOG_FLAGS,
  },
  requiresWhen: DIALOG_RULES,
  examples: [
    "hound element press --session-name demo --key Enter --json",
    "hound element press --session-name demo --key Escape --ref e4 --json",
    "hound element press --session-name demo --key Control+A --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    const r = await callSession(ctx, s, "press", { key: input.key, ...(input.ref && { ref: input.ref }), ...dialogParams(input) });
    return {
      summary: `Pressed ${r.key}; now at ${r.url}.${dialogNote(r)}`,
      data: { key: r.key, url: r.url, title: r.title, ...dialogData(r) },
      next_actions: afterAct(s),
    };
  },
});

export const elementCommands = [elementClick, elementDrag, elementCheck, elementUncheck, elementRead, elementHover, elementFill, elementType, elementSelect, elementPress, elementDownload, elementUpload];
