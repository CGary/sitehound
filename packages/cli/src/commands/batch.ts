/**
 * `hound batch`: several page/element/diag steps of one browser session in one CLI call (fewer agent round trips).
 *
 * Every step is parsed and validated up front with the exact parser and declared rules of its standalone command
 * (`parseFlags`), so nothing runs when any step is wrong. A step's arg may reference the `data` of an earlier step
 * (`$prev.<path>`, `$steps[<i>].<path>`); such args count as given during the up-front check and are parsed again,
 * with their real values, right before the step runs.
 */
import { existsSync, statSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HoundError } from "@sitehound/core/errors";
import { BATCH_DEFAULT_MAX_STEPS, BATCH_FILE_MAX_CHARS, BATCH_MAX_STEPS, BATCH_OUTPUT_MAX_CHARS } from "@sitehound/core/limits";
import { withTimeout } from "../framework/cli.ts";
import { errorEnvelope, toHoundError } from "../framework/envelope.ts";
import { nearest } from "../framework/nearest.ts";
import { UNIVERSAL_FLAGS, parseFlags } from "../framework/parse.ts";
import { checkMaxChars } from "../framework/rules.ts";
import { defineCommand, type Command, type CommandContext, type NextAction } from "../framework/types.ts";
import { SESSION_FLAG } from "./browser-shared.ts";
import { shellQuote } from "./shared.ts";

/** A step may run any page, element or diag command, and browser status. Nothing that opens/closes sessions, prompts, or nests. */
const allowedInBatch = (c: Command): boolean => {
  const domain = c.name.split(".")[0];
  return domain === "page" || domain === "element" || domain === "diag" || c.name === "browser.status";
};

const label = (c: Command): string => c.name.replace(".", " ");

/** `$prev.<path>` / `$steps[<i>].<path>`; path segments are keys or array indexes (`matches.0.ref` or `matches[0].ref`). */
const REFERENCE = /^\$(prev|steps\[(\d{1,4})\])((?:\.[A-Za-z0-9_-]+|\[\d{1,6}\])+)$/;
const LOOKS_LIKE_REFERENCE = /^\$(?:prev|steps)(?![A-Za-z0-9_])/;

interface Reference {
  /** Index of the step whose data is read. */
  from: number;
  path: string[];
  text: string;
}

interface Step {
  i: number;
  cmd: Command;
  args: Record<string, unknown>;
  /** Flags whose value is (or contains) a reference, with the references by array position (-1: the value itself). */
  refs: Map<string, Map<number, Reference>>;
}

interface StepResult {
  i: number;
  command: string;
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: { code: string; message: string; field?: string; received?: unknown; allowed?: readonly string[]; retryable: boolean };
  /** Characters of `data` left out because the batch output would be too large (the full results are in data.file). */
  dataOmitted?: number;
}

const stepField = (i: number, rest?: string) => (rest === undefined ? `steps[${i}]` : `steps[${i}].${rest}`);

function invalid(message: string, field: string, extra: { received?: unknown; allowed?: readonly string[]; suggestedFix?: string } = {}): HoundError {
  return new HoundError("INVALID_ARGUMENT", message, { field, retryable: true, suggestedFix: "hound batch --schema", ...extra });
}

/** Rewrites an error raised for a step's flags so it points at `steps[i].args.<flag>`; keeps codes (and so exit codes). */
function forStep(err: unknown, step: Step, upFront: boolean): HoundError {
  const he = toHoundError(err);
  const d = he.details;
  const names = d.field?.split("|") ?? [];
  // session-name belongs to batch itself (SESSION_NOT_FOUND...), not to the step's args.
  const onFlags = names.length > 0 && names.every((n) => n !== "session-name" && (n in step.cmd.flags || n === "timeout"));
  const field = onFlags ? names.map((n) => stepField(step.i, `args.${n}`)).join("|") : d.field === undefined ? stepField(step.i) : d.field;
  const sensitive = names.some((n) => step.cmd.flags[n]?.sensitive);
  return new HoundError(he.code, `${stepField(step.i)} (${label(step.cmd)}): ${he.message}`, {
    field,
    ...(d.received !== undefined && !sensitive && { received: d.received }),
    ...(d.allowed !== undefined && { allowed: d.allowed }),
    ...(d.retryable !== undefined && { retryable: d.retryable }),
    // A corrected standalone command would not fix the batch file; point at the step's contract instead.
    ...(upFront ? { suggestedFix: `hound ${label(step.cmd)} --schema --json` } : d.suggestedFix ? { suggestedFix: d.suggestedFix } : {}),
    ...(d.data !== undefined && { data: d.data }),
  });
}

/** The text of a value in an error: nothing at all when the flag is sensitive (a value that looks like a reference may be a secret). */
const quoted = (text: string, sensitive: boolean, max = 80): string => (sensitive ? "the value" : `"${text.slice(0, max)}"`);
const receivedOf = (text: string, sensitive: boolean) => (sensitive ? {} : { received: text.slice(0, 80) });

function parseReference(text: string, i: number, field: string, sensitive = false): Reference | undefined {
  if (!LOOKS_LIKE_REFERENCE.test(text)) return undefined;
  const m = REFERENCE.exec(text);
  if (!m) {
    throw invalid(`${field}: ${quoted(text, sensitive)} is not a valid reference; use $prev.<path> or $steps[<i>].<path> (e.g. $prev.matches.0.ref), or start the value with $$prev or $$steps for a literal $prev / $steps.`, field, receivedOf(text, sensitive));
  }
  const from = m[1] === "prev" ? i - 1 : Number(m[2]);
  if (from < 0 || from >= i) {
    throw invalid(`${field}: ${quoted(text, sensitive, 200)} must refer to an earlier step (${i === 0 ? "the first step has none" : `0..${i - 1}`}).`, field, receivedOf(text, sensitive));
  }
  const path = m[3]!.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  return { from, path, text };
}

/** Reads and checks the steps file: JSON array of { command, args? } with known, allowed commands. */
function parseSteps(text: string, catalog: readonly Command[], maxSteps: number): Step[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // Never echo the content (steps may hold values to type): position only.
    const at = /position (\d+)/.exec(err instanceof Error ? err.message : "")?.[1];
    throw invalid(`The steps are not valid JSON${at ? ` (at character ${at})` : ""}.`, "file");
  }
  if (!Array.isArray(raw)) throw invalid('The steps must be a JSON array of {"command": "...", "args": {...}} objects.', "file");
  if (raw.length === 0) throw invalid("The steps array is empty.", "file");
  if (raw.length > maxSteps) {
    throw invalid(`${raw.length} steps given; --max-steps allows ${maxSteps} (at most ${BATCH_MAX_STEPS}).`, "max-steps", {
      received: raw.length,
      ...(raw.length <= BATCH_MAX_STEPS && { suggestedFix: `hound batch --session-name "<session-name>" --file "<file>" --max-steps ${raw.length} --json` }),
    });
  }
  const usable = catalog.filter(allowedInBatch);
  const names = usable.map(label);
  return raw.map((entry, i): Step => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw invalid(`${stepField(i)} must be an object {"command": "...", "args": {...}}.`, stepField(i));
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) if (key !== "command" && key !== "args") throw invalid(`${stepField(i)} has an unknown key "${key.slice(0, 40)}"; only "command" and "args" are allowed.`, stepField(i, key.slice(0, 40)));
    if (typeof e.command !== "string") throw invalid(`${stepField(i, "command")} must be a string such as "element click".`, stepField(i, "command"));
    const wanted = e.command.trim().replace(/\s+|\./g, " ");
    const cmd = catalog.find((c) => label(c) === wanted);
    if (!cmd) {
      const near = nearest(wanted, names);
      throw new HoundError("UNKNOWN_COMMAND", `${stepField(i, "command")}: unknown command "${wanted.slice(0, 60)}".${near ? ` Did you mean "${near}"?` : ""}`, {
        field: stepField(i, "command"),
        received: wanted.slice(0, 60),
        allowed: names,
        retryable: true,
        suggestedFix: near ? `hound ${near} --schema --json` : "hound batch --schema",
      });
    }
    if (!allowedInBatch(cmd)) {
      throw invalid(`${stepField(i, "command")}: "${label(cmd)}" cannot run inside batch; steps may use page, element and diag commands and browser status (run it on its own).`, stepField(i, "command"), {
        received: label(cmd),
        allowed: names,
      });
    }
    const args = e.args === undefined ? {} : e.args;
    if (args === null || typeof args !== "object" || Array.isArray(args)) throw invalid(`${stepField(i, "args")} must be an object of flag names (without --) to values.`, stepField(i, "args"));
    const step: Step = { i, cmd, args: args as Record<string, unknown>, refs: new Map() };
    for (const [name, value] of Object.entries(step.args)) {
      const field = stepField(i, `args.${name.slice(0, 40)}`);
      if (name === "session-name") throw invalid(`${field}: the session is set by batch --session-name and cannot be given per step.`, field);
      if (name in UNIVERSAL_FLAGS && !(name in cmd.flags) && name !== "timeout") throw invalid(`${field}: universal flags are not allowed in a step (only timeout).`, field, { allowed: ["timeout"] });
      const spec = cmd.flags[name];
      if (!spec && name !== "timeout") {
        const flags = Object.keys(cmd.flags).filter((n) => n !== "session-name");
        const near = nearest(name, flags);
        throw invalid(`${field}: unknown flag for ${label(cmd)}.${near ? ` Did you mean "${near}"?` : ""} Allowed: ${[...flags, "timeout"].join(", ")}`, field, { received: name.slice(0, 40), allowed: [...flags, "timeout"] });
      }
      const values = Array.isArray(value) ? value : [value];
      const found = new Map<number, Reference>();
      const sensitive = spec?.sensitive === true;
      values.forEach((v, at) => {
        if (typeof v === "boolean" && spec?.type !== "boolean") {
          // true would become a bare "--flag" and make the parser read the next token as its value.
          throw invalid(`${field}: ${label(cmd)} --${name.slice(0, 40)} takes a ${spec?.type === "integer" ? "number" : "string"}, not true/false (only switches take booleans).`, field);
        }
        if (typeof v === "string") {
          const ref = parseReference(v, i, field, sensitive);
          if (ref) found.set(Array.isArray(value) ? at : -1, ref);
          else if (v === "-" && spec?.type === "path") throw invalid(`${field}: "-" (stdin) is not available inside batch; give a file path.`, field, { received: "-" });
        } else if (!(typeof v === "number" && Number.isFinite(v)) && typeof v !== "boolean") {
          throw invalid(`${field} must be a string, a number, a boolean or an array of strings and numbers.`, field);
        }
        if (Array.isArray(value) && typeof v === "boolean") throw invalid(`${field}: arrays hold strings or numbers only.`, field);
      });
      if (found.size) step.refs.set(name, found);
    }
    return step;
  });
}

/** One argv token list for the standalone parser. `skip` leaves flags out (deferred references). */
function argvOf(step: Step, values: Record<string, unknown>, skip: ReadonlySet<string> = new Set()): string[] {
  const argv: string[] = [];
  const token = (name: string, v: unknown) => argv.push(`--${name}=${String(v)}`);
  for (const [name, value] of Object.entries(values)) {
    if (skip.has(name)) continue;
    if (value === true) argv.push(`--${name}`);
    else if (value === false) argv.push(`--${name}=false`);
    else if (Array.isArray(value)) value.forEach((v) => token(name, v));
    else token(name, value);
  }
  return argv;
}

/** `$$prev...` / `$$steps...` in a literal arg is the text `$prev...` / `$steps...`. Nothing else is unescaped: `$$abc` stays `$$abc`, and values taken from earlier steps are never touched. */
const ESCAPED_REFERENCE = /^\$\$(?=(?:prev|steps)(?![A-Za-z0-9_]))/;
const unescapeLiteral = (v: unknown): unknown => (typeof v === "string" ? v.replace(ESCAPED_REFERENCE, "$") : v);
const literalArgs = (step: Step): Record<string, unknown> =>
  Object.fromEntries(Object.entries(step.args).map(([k, v]) => [k, Array.isArray(v) ? v.map(unescapeLiteral) : unescapeLiteral(v)]));

/** The step's args with every reference replaced by the value it points at (INVALID_ARGUMENT when it cannot). */
function resolveArgs(step: Step, results: readonly StepResult[]): Record<string, unknown> {
  const out: Record<string, unknown> = literalArgs(step);
  for (const [name, refs] of step.refs) {
    const field = stepField(step.i, `args.${name}`);
    const sensitive = step.cmd.flags[name]?.sensitive === true;
    /** What an error says about a reference: its text, unless the flag is sensitive (the "reference" may be the secret itself). */
    const shownRef = (ref: Reference) => (sensitive ? "the reference" : ref.text);
    const ex = (ref: Reference) => receivedOf(ref.text, sensitive);
    const resolve = (ref: Reference): unknown => {
      const source = results.find((r) => r.i === ref.from);
      if (!source?.ok) throw invalid(`${field}: ${shownRef(ref)} cannot be resolved: step ${ref.from} ${source ? "failed" : "did not run"}.`, field, ex(ref));
      let cur: unknown = source.data;
      for (const key of ref.path) {
        if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, key)) {
          throw invalid(`${field}: ${shownRef(ref)} cannot be resolved: step ${ref.from} has no data${sensitive ? "" : ` at "${ref.path.join(".")}"`}.`, field, ex(ref));
        }
        cur = (cur as Record<string, unknown>)[key];
      }
      return cur;
    };
    const value = step.args[name];
    if (Array.isArray(value)) {
      out[name] = value.map((v, at) => {
        const ref = refs.get(at);
        if (!ref) return v;
        const got = resolve(ref);
        if (typeof got !== "string" && typeof got !== "number") throw invalid(`${field}: ${shownRef(ref)} is not a string or a number.`, field, ex(ref));
        return got;
      });
      continue;
    }
    const ref = refs.get(-1)!;
    const got = resolve(ref);
    const repeatable = step.cmd.flags[name]?.repeatable === true;
    const scalar = (v: unknown) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean";
    if (scalar(got) || (repeatable && Array.isArray(got) && got.every((v) => typeof v === "string" || typeof v === "number"))) out[name] = got;
    else throw invalid(`${field}: ${shownRef(ref)} resolves to ${Array.isArray(got) ? "an array" : got === null ? "null" : typeof got}, not a value for --${name}.`, field, ex(ref));
  }
  return out;
}

/** Keeps the fields an agent needs to find omitted data (files, URL, counts). */
function keepWhenOmitted(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const d = data as Record<string, unknown>;
  return Object.fromEntries(["file", "snapshotFile", "url", "title", "ref", "refs", "total", "truncated"].filter((k) => d[k] !== undefined).map((k) => [k, d[k]]));
}

async function readStepsText(cmd: Command, file: string): Promise<string> {
  if (file === "-") {
    if (process.stdin.isTTY) throw invalid("--file - reads the steps from stdin, but stdin is a terminal. Pipe the JSON in.", "file", { received: "-" });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += (chunk as Buffer).length;
      if (size > BATCH_FILE_MAX_CHARS * 4) break;
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    checkMaxChars(cmd, "file", text.length);
    return text;
  }
  if (!existsSync(file) || !statSync(file).isFile()) throw new HoundError("FILE_NOT_FOUND", `Steps file not found: ${file}`, { field: "file", received: file, retryable: true });
  if (statSync(file).size > BATCH_FILE_MAX_CHARS * 4) checkMaxChars(cmd, "file", statSync(file).size);
  const text = await readFile(file, "utf8");
  checkMaxChars(cmd, "file", text.length);
  return text;
}

export function batchCommand(catalog: readonly Command[]): Command {
  const usable = catalog.filter(allowedInBatch).map(label);
  return defineCommand({
    name: "batch",
    description:
      "Run several page/element/diag steps (and browser status) of one session in a single call to save round trips. Every step is validated up front with its command's own rules (nothing runs if one is wrong); steps run in order and stop at the first failure unless --continue-on-error. A step arg can take a value from an earlier step's data: $prev.<path> or $steps[<i>].<path>. Sensitive values (value, dialog-text) are never echoed. See input.file_format in --schema.",
    kind: "write",
    flags: {
      ...SESSION_FLAG,
      file: {
        type: "path",
        required: true,
        maxChars: BATCH_FILE_MAX_CHARS,
        description: `JSON file with the steps, or - for stdin (at most ${BATCH_FILE_MAX_CHARS} characters; format in input.file_format)`,
      },
      "continue-on-error": { type: "boolean", description: "Run the remaining steps after a failed one (default: stop at the first failure)" },
      "max-steps": { type: "integer", default: BATCH_DEFAULT_MAX_STEPS, min: 1, max: BATCH_MAX_STEPS, description: "Refuse a steps file with more steps than this" },
    },
    fileFormat: {
      description:
        "A JSON array of steps, run in order on --session-name. Each step is validated with the same flags, ranges, enums and rules as the standalone command before any step runs (usage errors exit 2 with field steps[i].args.<flag>).",
      type: "array",
      minItems: 1,
      maxItems: `--max-steps (default ${BATCH_DEFAULT_MAX_STEPS}, at most ${BATCH_MAX_STEPS})`,
      items: {
        type: "object",
        required: ["command"],
        additionalProperties: false,
        properties: {
          command: { type: "string", enum: usable, description: 'A page, element or diag command, or browser status, as "domain verb"' },
          args: {
            type: "object",
            description:
              "Flags of that command without the leading --: string, number, boolean (true = the switch is on) or an array for repeatable flags (e.g. option, file). session-name is set by batch and may not be given; timeout (seconds, per step) is the only universal flag allowed; '-' (stdin) is not allowed for path flags.",
          },
        },
      },
      references: {
        syntax: ["$prev.<path>", "$steps[<i>].<path>"],
        description:
          "A string arg that is exactly a reference takes its value from the data of an earlier step (i is 0-based and must be lower than the current step): keys and array indexes separated by dots (matches.0.ref, or matches[0].ref). A reference that cannot be resolved (the step failed or did not run, the path is missing, or it is not a string/number/boolean) fails that step with INVALID_ARGUMENT. Start a value with $$prev or $$steps for a literal $prev / $steps; any other $ (a password such as $$abc) is passed as is, and values taken from earlier steps are never altered.",
        example: [
          { command: "page find", args: { text: "Guardar" } },
          { command: "element click", args: { ref: "$prev.matches.0.ref" } },
          { command: "page wait", args: { for: "text", value: "Guardado", timeout: 20 } },
        ],
      },
      output: {
        description:
          "data { steps: [{ i, command, ok, summary, data?, error? }], completed, failed, skipped, file? }. Step data is the standalone command's data (snapshots keep their --limit-chars default of 8000); when all step data together exceeds the output budget the later steps keep only file/url/count fields (dataOmitted) and the full results go to data.file (0600). Any failed step: ok false, exit 1 (error PARTIAL_SUCCESS when a step succeeded, else the failed step's own error).",
        outputBudgetChars: BATCH_OUTPUT_MAX_CHARS,
      },
    },
    examples: [
      "hound batch --session-name shop --file ./steps.json --json",
      `printf '%s' '[{"command":"page find","args":{"text":"Guardar"}},{"command":"element click","args":{"ref":"$prev.matches.0.ref"}}]' | hound batch --session-name erp --file - --json`,
      "hound batch --session-name shop --file ./steps.json --continue-on-error --max-steps 100 --json",
    ],
    async run(input, ctx) {
      const session: string = input["session-name"];
      const steps = parseSteps(await readStepsText(this, input.file), catalog, input["max-steps"]);

      // Up front: every step through its command's own parser and rules; references count as given.
      for (const step of steps) {
        try {
          parseFlags(step.cmd, [`--session-name=${session}`, ...argvOf(step, literalArgs(step), new Set(step.refs.keys()))], ctx.cwd, { deferred: new Set([...step.refs.keys()].filter((n) => n in step.cmd.flags)) });
        } catch (err) {
          throw forStep(err, step, true);
        }
      }

      const results: StepResult[] = [];
      let lastNext: NextAction[] = [];
      for (const step of steps) {
        if (ctx.signal.aborted) break;
        const command = label(step.cmd);
        try {
          const values = resolveArgs(step, results);
          const { input: stepInput, universal, given } = parseFlags(step.cmd, [`--session-name=${session}`, ...argvOf(step, values)], ctx.cwd);
          const seconds = universal.timeout ?? step.cmd.timeoutSeconds;
          const controller = new AbortController();
          const onAbort = () => controller.abort();
          ctx.signal.addEventListener("abort", onAbort, { once: true });
          const stepCtx: CommandContext = {
            name: step.cmd.name,
            signal: controller.signal,
            ...(seconds ? { timeoutMs: seconds * 1000 } : {}),
            interactive: false,
            quiet: ctx.quiet,
            debug: ctx.debug,
            given,
            cwd: ctx.cwd,
            log: (message) => ctx.log(`[step ${step.i}] ${message}`),
          };
          try {
            const r = await withTimeout(step.cmd, stepInput, stepCtx, controller, seconds);
            results.push({ i: step.i, command, ok: true, summary: r.summary, data: r.data ?? {} });
            lastNext = r.next_actions ?? [];
          } finally {
            ctx.signal.removeEventListener("abort", onAbort);
          }
        } catch (err) {
          const he = forStep(err, step, false);
          const d = he.details;
          results.push({
            i: step.i,
            command,
            ok: false,
            summary: he.message,
            error: {
              code: he.code,
              message: he.message,
              ...(d.field !== undefined && { field: d.field }),
              ...(d.received !== undefined && { received: typeof d.received === "string" ? d.received.slice(0, 300) : d.received }),
              ...(d.allowed !== undefined && { allowed: d.allowed }),
              retryable: errorEnvelope(step.cmd.name, he, false).retryable,
            },
          });
          lastNext = d.suggestedFix ? [{ command: d.suggestedFix, reason: `Suggested fix for step ${step.i}.` }] : [];
          if (!input["continue-on-error"]) break;
        }
      }

      // Inline output budget: later step data is cut to its file/url/count fields; the full results go to a private file.
      const full = results.map((r) => ({ ...r }));
      let budget = BATCH_OUTPUT_MAX_CHARS;
      for (const r of results) {
        if (r.data === undefined) continue;
        const size = JSON.stringify(r.data)?.length ?? 0;
        if (size <= budget) budget -= size;
        else {
          r.data = keepWhenOmitted(r.data);
          r.dataOmitted = size;
          budget = 0;
        }
      }
      let file: string | undefined;
      if (results.some((r) => r.dataOmitted !== undefined)) {
        const { browserSessionRunsDir, ensurePrivateDir } = await import("@sitehound/core");
        file = join(await ensurePrivateDir(browserSessionRunsDir(session)), `batch-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.json`);
        await writeFile(file, JSON.stringify({ session, steps: full }, null, 2), { mode: 0o600, flag: "wx" });
        await chmod(file, 0o600);
      }

      const completed = results.filter((r) => r.ok).length;
      const failed = results.length - completed;
      const skipped = steps.length - results.length;
      const data = { steps: results, completed, failed, skipped, ...(file && { file }) };
      if (file) lastNext = [...lastNext.slice(0, 2), { command: `head -c 20000 ${shellQuote(file)}`, reason: "Read the full step results (some step data was left out of this envelope)." }];
      const firstFailure = results.find((r) => !r.ok);
      if (firstFailure?.error) {
        const e = firstFailure.error;
        throw new HoundError(
          completed > 0 ? "PARTIAL_SUCCESS" : (e.code as HoundError["code"]),
          `${failed} of ${steps.length} step(s) failed (${completed} completed${skipped ? `, ${skipped} not run` : ""}). First failure: ${e.message}`,
          {
            ...(e.field !== undefined && { field: e.field }),
            ...(completed === 0 && e.received !== undefined && { received: e.received }),
            ...(completed === 0 && e.allowed !== undefined && { allowed: e.allowed }),
            // Steps that ran may have changed the page: rerunning the whole batch is not safe by default.
            retryable: completed === 0 ? e.retryable : false,
            ...(lastNext[0] && { suggestedFix: lastNext[0].command }),
            data,
          },
        );
      }
      const last = results[results.length - 1]!;
      return {
        summary: `Ran ${completed} step(s), all ok. Last (${last.command}): ${last.summary}`,
        data,
        next_actions: lastNext.slice(0, 3),
        plain: results.map((r) => `${r.i} ${r.command}: ${r.ok ? "ok" : "FAILED"} - ${r.summary}`).join("\n"),
      };
    },
  });
}
