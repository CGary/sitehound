/** The declarative command registry types. Everything else (parsing, help, schema, envelope) derives from these. */

export type FlagType = "string" | "integer" | "boolean" | "enum" | "path";

export interface FlagSpec {
  type: FlagType;
  /** Closed set of allowed values (required when `type` is "enum"). */
  values?: readonly string[];
  default?: string | number | boolean;
  required?: boolean;
  /** May be given several times; the input value is then an array. */
  repeatable?: boolean;
  /** Never echoed back in suggested fixes (e.g. text to type into a field). */
  sensitive?: boolean;
  /** integer: inclusive bounds. */
  min?: number;
  max?: number;
  /** string/path: the value must match this regular expression source (flags in `patternFlags`). */
  pattern?: string;
  patternFlags?: string;
  /** Human wording of the pattern rule, used in the error message. */
  patternHint?: string;
  /** string: maximum length in characters. */
  maxLength?: number;
  /** path (a file or `-` for stdin): maximum characters of the CONTENT read from it; checked by the command, shown by --schema. */
  maxChars?: number;
  description: string;
}

/** Values a rule condition compares against: one value, or any of several. */
export type WhenValue = string | boolean | readonly string[];

/**
 * A conditional rule, declared in the registry (and shown by --schema) and checked before any work starts.
 * `when` matches on the typed input (defaults included); every entry must match.
 */
export interface ConditionalRule {
  when: Record<string, WhenValue>;
  /** Flags that must be given when `when` matches. */
  require?: readonly string[];
  /** Flags that must NOT be given when `when` matches. */
  forbid?: readonly string[];
  /** Closed sets a flag's value must belong to when `when` matches (INVALID_ENUM otherwise). */
  restrict?: Record<string, readonly string[]>;
}

/**
 * A cross-field cost rule, declared on the command and shown by --schema: for a text of N characters (from one of `text`,
 * a flag or a file the command reads), `baseMs + N * (value of `perChar` + extraMs)` must not exceed `maxMs`.
 * Checked by the command after it has read the text (checkCostRules).
 */
export interface CostRule {
  /** The flags that can supply the text. */
  text: readonly string[];
  /** The integer flag giving milliseconds per character. */
  perChar: string;
  extraMs: number;
  baseMs: number;
  maxMs: number;
}

export type CommandKind = "read" | "write" | "session";

/** Parsed, validated flags by long name (no dashes). Booleans/integers/enums are already typed; paths are absolute. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Input = Record<string, any>;

export interface NextAction {
  /** A complete, runnable `hound ... --json` command. */
  command: string;
  reason: string;
}

export interface CommandResult {
  /** One short line. */
  summary: string;
  /** The real result (JSON-serializable). */
  data: unknown;
  /** At most 3. */
  next_actions?: NextAction[];
  /** Optional human text for --plain / TTY (defaults to `summary`). */
  plain?: string;
}

export interface CommandContext {
  /** Dotted command name, e.g. "task.run". */
  name: string;
  /** Aborted when --timeout elapses. Long operations should listen to it. */
  signal: AbortSignal;
  /** The effective timeout (--timeout, else the command default) in milliseconds; undefined = no limit. */
  timeoutMs?: number;
  /** True only when stdin AND stdout are TTYs and --no-input was not given. Never prompt otherwise. */
  interactive: boolean;
  quiet: boolean;
  debug: boolean;
  /** Names of the flags the caller passed explicitly (defaults not included). */
  given: ReadonlySet<string>;
  /** The caller's working directory (relative path flags are already resolved against it). */
  cwd: string;
  /** Progress/diagnostics. Always goes to stderr (silenced by --quiet). Never log page content, cookies or headers. */
  log(message: string): void;
}

export interface Command {
  /** "domain.verb". */
  name: string;
  /** One line. */
  description: string;
  kind: CommandKind;
  /** By long name, without dashes. */
  flags: Record<string, FlagSpec>;
  /** Exactly-one-of groups of flag names, e.g. [["value", "value-file"]]. */
  requires?: readonly (readonly string[])[];
  /** Conditional requirements, e.g. { when: { scope: "element" }, require: ["ref"] }. */
  requiresWhen?: readonly ConditionalRule[];
  /**
   * Exactly-one-of groups for dangerous actions: giving none is CONFIRMATION_REQUIRED (exit 2) with every
   * alternative as a runnable command; giving several is INVALID_ARGUMENT.
   */
  confirm?: readonly { oneOf: readonly string[]; message: string }[];
  /** Cross-field cost rules (see CostRule). */
  costRules?: readonly CostRule[];
  /** Exactly 3 complete example commands. */
  examples: readonly [string, string, string];
  /** Default --timeout in seconds when the caller gives none. Omit for no limit. */
  timeoutSeconds?: number;
  run(input: Input, ctx: CommandContext): Promise<CommandResult>;
}

export const defineCommand = (command: Command): Command => command;
