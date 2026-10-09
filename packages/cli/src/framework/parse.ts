import { isAbsolute, resolve } from "node:path";
import { HoundError } from "@sitehound/core/errors";
import { nearest } from "./nearest.ts";
import type { Command, ConditionalRule, FlagSpec, Input, WhenValue } from "./types.ts";
import { placeholder, ruleApplies, usageLine } from "./usage.ts";

/** Flags every command accepts. They are consumed by the framework, never passed to `run`. */
export const UNIVERSAL_FLAGS: Record<string, FlagSpec> = {
  json: { type: "boolean", description: "Print the JSON envelope (default when stdout is not a TTY)" },
  plain: { type: "boolean", description: "Print short human text instead of JSON" },
  quiet: { type: "boolean", description: "Suppress progress on stderr and extra plain lines" },
  debug: { type: "boolean", description: "Include stack traces and diagnostics" },
  "no-input": { type: "boolean", description: "Never prompt; fail instead" },
  timeout: { type: "integer", description: "Abort after this many seconds (TIMEOUT error)" },
  schema: { type: "boolean", description: "Print this command's JSON contract and exit" },
  help: { type: "boolean", description: "Show help" },
  version: { type: "boolean", description: "Print the version" },
};

export interface Universal {
  json: boolean;
  plain: boolean;
  quiet: boolean;
  debug: boolean;
  noInput: boolean;
  timeout?: number;
  schema: boolean;
  help: boolean;
  version: boolean;
}

/**
 * Cheap, non-throwing pre-scan so errors raised before full parsing still honor --json/--plain/--debug.
 * With `cmd`, the token after a value-taking flag is that flag's value (so `--value -h` is not a help request).
 */
export function scanUniversal(argv: readonly string[], cmd?: Command): Pick<Universal, "json" | "plain" | "quiet" | "debug" | "help" | "version" | "schema"> {
  const on = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "-h") {
      on.add("help");
      continue;
    }
    const m = token.match(/^--([^=\s]+)(?:=(.*))?$/s);
    if (!m) continue;
    const name = m[1]!;
    const spec = cmd ? (cmd.flags[name] ?? UNIVERSAL_FLAGS[name]) : UNIVERSAL_FLAGS[name];
    if (cmd && spec && spec.type !== "boolean" && m[2] === undefined) {
      i++; // the next token is this flag's value, whatever it looks like
      continue;
    }
    if (name in UNIVERSAL_FLAGS && (m[2] === undefined || m[2] === "true")) on.add(name);
  }
  return {
    json: on.has("json"),
    plain: on.has("plain"),
    quiet: on.has("quiet"),
    debug: on.has("debug"),
    help: on.has("help"),
    version: on.has("version"),
    schema: on.has("schema"),
  };
}

/** Stand-in value of a deferred flag while the rules are checked (never sent to a command). */
const DEFERRED = "\u0000deferred";

function bad(cmd: Command, given: Record<string, unknown>, message: string, field: string, extra: { received?: unknown; allowed?: readonly string[] } = {}): HoundError {
  return new HoundError("INVALID_ARGUMENT", message, { field, ...extra, retryable: true, suggestedFix: usageLine(cmd, given) });
}

/**
 * Splits argv (after the `domain verb` tokens) into universal flags and the command's own typed input.
 * Accepts `--key value` and `--key=value`; booleans never consume the next token.
 */
export function parseFlags(
  cmd: Command,
  argv: readonly string[],
  cwd: string,
  opts: { deferred?: ReadonlySet<string> } = {},
): { input: Input; universal: Universal; given: ReadonlySet<string> } {
  const given: Record<string, unknown> = {};
  // Deferred flags (batch references such as "$prev.matches.0.ref") count as given for every presence rule; their
  // values are only known later, when the command is parsed again with them filled in.
  const deferred = opts.deferred ?? new Set<string>();
  for (const name of deferred) if (cmd.flags[name]) given[name] = DEFERRED;
  const raw: Record<string, string[] | true[]> = {};
  const universalRaw: Record<string, string | true> = {};
  const allowedFlags = [...Object.keys(cmd.flags), ...Object.keys(UNIVERSAL_FLAGS)].map((n) => `--${n}`);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "-h") {
      universalRaw.help = true;
      continue;
    }
    const m = token.match(/^--([^=\s]+)(?:=(.*))?$/s);
    if (!m) {
      throw bad(cmd, given, `Unexpected argument "${token}". Flags are --name value; this command takes no positional arguments.`, "argument", { received: token });
    }
    const name = m[1]!;
    const inline = m[2];
    const spec = cmd.flags[name] ?? UNIVERSAL_FLAGS[name];
    if (!spec) {
      throw bad(cmd, given, `Unknown flag --${name}. Allowed: ${allowedFlags.join(", ")}`, name, { received: `--${name}`, allowed: allowedFlags });
    }
    let value: string | true;
    if (spec.type === "boolean") {
      if (inline !== undefined && inline !== "true" && inline !== "false") {
        throw bad(cmd, given, `--${name} is a switch; use it bare or as --${name}=true|false.`, name, { received: inline });
      }
      if (inline === "false") continue; // explicitly off: same as unset
      value = true;
    } else if (inline !== undefined) {
      value = inline;
    } else {
      const next = argv[i + 1];
      if (next === undefined) throw bad(cmd, given, `Flag --${name} needs a value.`, name);
      if (next.startsWith("-") && next !== "-") throw dashValue(cmd, given, name, spec, next);
      value = next;
      i++;
    }
    if (name in UNIVERSAL_FLAGS && !(name in cmd.flags)) {
      universalRaw[name] = value;
      continue;
    }
    if (!spec.repeatable && name in raw) throw bad(cmd, given, `Flag --${name} was given more than once.`, name);
    (raw[name] ??= []).push(value as never);
    given[name] = spec.repeatable ? raw[name] : value;
  }

  const input: Input = {};
  for (const [name, spec] of Object.entries(cmd.flags)) {
    if (deferred.has(name)) {
      input[name] = DEFERRED;
      continue;
    }
    const vals = raw[name];
    if (!vals) {
      if (spec.default !== undefined) input[name] = spec.default;
      else if (spec.type === "boolean") input[name] = false;
      else if (spec.repeatable) input[name] = [];
      continue;
    }
    const typed = vals.map((v) => coerce(cmd, given, cwd, name, spec, v));
    input[name] = spec.repeatable ? typed : typed[0];
  }

  validateRules(cmd, input, given);

  const timeoutRaw = universalRaw.timeout;
  let timeout: number | undefined;
  if (timeoutRaw !== undefined) {
    timeout = coerce(cmd, given, cwd, "timeout", UNIVERSAL_FLAGS.timeout!, timeoutRaw) as number;
    if (timeout <= 0) throw bad(cmd, given, "--timeout must be a positive number of seconds.", "timeout", { received: timeout });
  }
  const u = (n: string) => universalRaw[n] === true;
  if (u("json") && u("plain")) throw bad(cmd, given, "--json and --plain are mutually exclusive.", "json|plain");
  const universal: Universal = {
    json: u("json"),
    plain: u("plain"),
    quiet: u("quiet"),
    debug: u("debug"),
    noInput: u("no-input"),
    timeout,
    schema: u("schema"),
    help: u("help"),
    version: u("version"),
  };
  return { input, universal, given: new Set(Object.keys(given)) };
}

/** A value-taking flag followed by a token that starts with "-": ask for the `--flag=value` form. */
function dashValue(cmd: Command, given: Record<string, unknown>, name: string, spec: FlagSpec, token: string): HoundError {
  const isFlag = /^--[A-Za-z]/.test(token);
  // A token like "--value=secret" is the next flag with its value glued on: never echo the value of a sensitive flag.
  const glued = /^--([A-Za-z][\w-]*)=/.exec(token);
  const leaks = glued !== null && (cmd.flags[glued[1]!]?.sensitive === true);
  const shown = leaks ? `--${glued![1]}=<value>` : token.slice(0, 80);
  const fix = isFlag || spec.sensitive || name === "value" ? usageLine(cmd, given, { [name]: placeholder(name, spec) }) : usageLine(cmd, given, { [name]: token });
  const hint = spec.sensitive ? `--${name}=<value>` : `--${name}=${shown}`;
  return new HoundError(
    "INVALID_ARGUMENT",
    `Flag --${name} needs a value, but the next token starts with "-"${spec.sensitive ? "" : ` ("${shown}")`}. ${isFlag ? "Give --" + name + " a value first, or " : "If it is the value, "}pass values that start with "-" glued to the flag: ${hint}`,
    { field: name, ...(spec.sensitive ? {} : { received: shown }), retryable: true, suggestedFix: fix },
  );
}

function rangeText(spec: FlagSpec): string {
  if (spec.min !== undefined && spec.max !== undefined) return `between ${spec.min} and ${spec.max}`;
  return spec.min !== undefined ? `at least ${spec.min}` : `at most ${spec.max}`;
}

function coerce(cmd: Command, given: Record<string, unknown>, cwd: string, name: string, spec: FlagSpec, value: string | true): string | number | boolean {
  if (spec.type === "boolean") return true;
  const text = String(value);
  const seen = spec.sensitive ? {} : { received: text.slice(0, 80) };
  switch (spec.type) {
    case "integer": {
      if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw bad(cmd, given, `--${name} must be an integer, got "${text.slice(0, 40)}".`, name, seen);
      const n = Number(text);
      if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) {
        const clamped = Math.min(spec.max ?? n, Math.max(spec.min ?? n, n));
        throw new HoundError("INVALID_ARGUMENT", `--${name} must be ${rangeText(spec)}, got ${n}.`, {
          field: name,
          received: n,
          retryable: true,
          suggestedFix: usageLine(cmd, given, { [name]: clamped }),
        });
      }
      return n;
    }
    case "enum": {
      const values = spec.values ?? [];
      if (!values.includes(text)) throw invalidEnum(cmd, given, name, `--${name}`, text, values);
      return text;
    }
    default: {
      if (spec.maxLength !== undefined && text.length > spec.maxLength) {
        throw new HoundError("INVALID_ARGUMENT", `--${name} must be at most ${spec.maxLength} characters, got ${text.length}.`, {
          field: name,
          retryable: true,
          suggestedFix: usageLine(cmd, given, { [name]: placeholder(name, spec) }),
        });
      }
      if (spec.pattern !== undefined && !new RegExp(spec.pattern, spec.patternFlags).test(text)) {
        const rule = `${spec.pattern}${spec.patternFlags?.includes("i") ? " (case-insensitive)" : ""}`;
        throw new HoundError("INVALID_ARGUMENT", `--${name} must match ${rule}${spec.patternHint ? `: ${spec.patternHint}` : ""}. Got "${text.slice(0, 80)}".`, {
          field: name,
          ...seen,
          retryable: true,
          suggestedFix: usageLine(cmd, given, { [name]: placeholder(name, spec) }),
        });
      }
      if (spec.type === "path") return text === "-" || isAbsolute(text) ? text : resolve(cwd, text);
      return text;
    }
  }
}

/** INVALID_ENUM whose fix is the closest allowed value, or none when nothing is close. */
function invalidEnum(cmd: Command, given: Record<string, unknown>, name: string, label: string, received: string, values: readonly string[], extra = ""): HoundError {
  const near = nearest(received, values);
  return new HoundError("INVALID_ENUM", `${label} must be one of: ${values.join(", ")}${extra}${near ? `. Closest: ${near}` : ""}`, {
    field: name,
    received,
    allowed: values,
    retryable: true,
    ...(near && { suggestedFix: usageLine(cmd, given, { [name]: near }) }),
  });
}

const list = (v: WhenValue): string => (Array.isArray(v) ? v.join(", ") : String(v));
const describeWhen = (when: Record<string, WhenValue>): string =>
  Object.entries(when)
    .map(([k, v]) => (Array.isArray(v) && v.length > 1 ? `--${k} is ${v.slice(0, -1).join(", ")} or ${v[v.length - 1]}` : `--${k} is ${list(v)}`))
    .join(" and ");
const isPresent = (given: Record<string, unknown>, name: string): boolean => {
  const v = given[name];
  return v !== undefined && !(Array.isArray(v) && v.length === 0);
};

/** Required flags, conditional rules, exactly-one-of groups and confirmation groups: all declared on the command. */
function validateRules(cmd: Command, input: Input, given: Record<string, unknown>): void {
  for (const [name, spec] of Object.entries(cmd.flags)) {
    if (spec.required && (input[name] === undefined || (Array.isArray(input[name]) && input[name].length === 0))) {
      throw new HoundError("MISSING_REQUIRED_FLAG", `Missing required flag: --${name}${spec.repeatable ? " (give it at least once)" : ""}`, {
        field: name,
        retryable: true,
        suggestedFix: usageLine(cmd, given),
      });
    }
  }
  for (const rule of cmd.requiresWhen ?? []) checkRule(cmd, rule, input, given);
  for (const group of cmd.requires ?? []) {
    const present = group.filter((n) => isPresent(given, n));
    const flags = group.map((n) => `--${n}`).join(" or ");
    if (present.length === 0) {
      throw new HoundError("MISSING_REQUIRED_FLAG", `Provide exactly one of: ${flags}`, {
        field: group.join("|"),
        allowed: group.map((n) => `--${n}`),
        retryable: true,
        suggestedFix: usageLine(cmd, given),
      });
    }
    if (present.length > 1) {
      throw bad(cmd, given, `Flags are mutually exclusive, give exactly one of: ${flags}`, group.join("|"), { received: present.map((n) => `--${n}`) });
    }
  }
  for (const group of cmd.requiresAny ?? []) {
    if (group.some((n) => isPresent(given, n))) continue;
    throw new HoundError("MISSING_REQUIRED_FLAG", `Provide at least one of: ${group.map((n) => `--${n}`).join(", ")}`, {
      field: group.join("|"),
      allowed: group.map((n) => `--${n}`),
      retryable: true,
      suggestedFix: usageLine(cmd, given),
    });
  }
  for (const group of cmd.confirm ?? []) {
    const present = group.oneOf.filter((n) => isPresent(given, n));
    const flags = group.oneOf.map((n) => `--${n}`).join(" or ");
    if (present.length > 1) {
      throw bad(cmd, given, `Flags are mutually exclusive, give exactly one of: ${flags}`, group.oneOf.join("|"), { received: present.map((n) => `--${n}`) });
    }
    if (present.length === 0) {
      const alternatives = group.oneOf.map((n) => usageLine(cmd, given, { [n]: true }));
      throw new HoundError("CONFIRMATION_REQUIRED", group.message, {
        field: group.oneOf.join("|"),
        allowed: group.oneOf.map((n) => `--${n}`),
        retryable: true,
        suggestedFix: alternatives[0]!,
        data: { alternatives },
      });
    }
  }
}

function checkRule(cmd: Command, rule: ConditionalRule, input: Input, given: Record<string, unknown>): void {
  if (!ruleApplies(rule.when, input)) return;
  const when = describeWhen(rule.when);
  const missing = (rule.require ?? []).filter((n) => !isPresent(given, n));
  if (missing.length) {
    const flags = missing.map((n) => `--${n}`).join(", ");
    throw new HoundError("MISSING_REQUIRED_FLAG", `${flags} ${missing.length > 1 ? "are" : "is"} required when ${when}.`, {
      field: missing[0]!,
      retryable: true,
      suggestedFix: usageLine(cmd, given),
    });
  }
  const extra = (rule.forbid ?? []).filter((n) => isPresent(given, n));
  if (extra.length) {
    const rest = Object.fromEntries(Object.entries(given).filter(([k]) => !extra.includes(k)));
    throw new HoundError("INVALID_ARGUMENT", `${extra.map((n) => `--${n}`).join(", ")} cannot be used when ${when}.`, {
      field: extra[0]!,
      received: extra.map((n) => `--${n}`),
      retryable: true,
      suggestedFix: usageLine(cmd, rest),
    });
  }
  for (const [name, values] of Object.entries(rule.restrict ?? {})) {
    const v = input[name];
    if (typeof v === "string" && v !== DEFERRED && !values.includes(v)) throw invalidEnum(cmd, given, name, `--${name}`, v, values, ` when ${when}`);
  }
}
