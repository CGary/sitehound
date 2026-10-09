import { HoundError } from "@sitehound/core/errors";
import type { Command, CommandContext, CommandResult } from "./types.ts";
import { parseFlags, scanUniversal } from "./parse.ts";
import { errorEnvelope, exitCodeFor, plainText, successEnvelope, toHoundError, type Envelope } from "./envelope.ts";
import { commandHelp, domainHelp, rootHelp } from "./help.ts";
import { unknownCommand, type Registry } from "./registry.ts";
import { commandSchema } from "./schema.ts";
import { claimOutput, configure } from "./lifecycle.ts";
import { writeStderr, writeStdout } from "./stdio.ts";

export interface CliHooks {
  version: string;
  /** Translates deprecated positional syntax to the new argv; undefined when `argv` is not legacy. */
  translateLegacy?(argv: readonly string[]): { argv: string[]; notice: string } | undefined;
}

const LEADING_UNIVERSAL = new Set(["--json", "--plain", "--quiet", "--debug", "--no-input", "--help", "--version", "--schema", "-h"]);

function splitCommand(argv: readonly string[]): { domain?: string; verb?: string; rest: string[] } {
  const lead: string[] = [];
  let i = 0;
  while (i < argv.length && LEADING_UNIVERSAL.has(argv[i]!)) lead.push(argv[i++]!);
  const pos: string[] = [];
  while (i < argv.length && pos.length < 2 && !argv[i]!.startsWith("-")) pos.push(argv[i++]!);
  return { domain: pos[0], verb: pos[1], rest: [...lead, ...argv.slice(i)] };
}

/** Runs the CLI for `argv` (without node/script) and returns the process exit code. */
export async function runCli(argv: readonly string[], registry: Registry, hooks: CliHooks): Promise<number> {
  let args = [...argv];
  const legacy = hooks.translateLegacy?.(args);
  if (legacy) {
    args = legacy.argv;
    if (!args.includes("--quiet")) writeStderr(`${legacy.notice}\n`);
  }
  const scan = scanUniversal(args);
  const asJson = scan.json || (!scan.plain && !process.stdout.isTTY);
  const { domain, verb, rest } = splitCommand(args);
  const debug = scan.debug;
  configure({ asJson, debug });

  const text = async (body: string) => {
    if (claimOutput()) await writeStdout(`${body}\n`);
    return 0;
  };

  const fail = async (command: string, err: unknown): Promise<number> => {
    const he = toHoundError(err);
    const env = errorEnvelope(command, he, debug);
    if (claimOutput()) {
      if (asJson) await writeStdout(`${JSON.stringify(env)}\n`);
      else writeStderr(`${plainText(env)}\n`);
    }
    return exitCodeFor(he.code);
  };

  if (!domain) {
    if (scan.version) return text(hooks.version);
    if (rest.length > 0 && !scan.help) {
      const first = rest.find((t) => !LEADING_UNIVERSAL.has(t));
      if (first) return fail("hound", unknownFlagAtRoot(first));
    }
    return text(rootHelp(registry, hooks.version));
  }
  if (!registry.domains().includes(domain)) return fail(verb ? `${domain}.${verb}` : domain, unknownCommand(registry, domain, verb));
  // A top-level command ("batch") has no verb: a second word is an unexpected positional argument for it.
  const solo = registry.find(domain, undefined);
  if (!verb && !solo) return text(domainHelp(registry, domain));
  const cmd = solo ?? registry.find(domain, verb);
  if (!cmd) return fail(`${domain}.${verb}`, unknownCommand(registry, domain, verb));
  const cmdArgs = solo && verb !== undefined ? [verb, ...rest] : rest;

  configure({ command: cmd.name });
  // Re-scan knowing the command: the token after a value-taking flag is its value (`--value -h` is not help).
  const known = scanUniversal(cmdArgs, cmd);
  if (known.help) return text(commandHelp(cmd));
  if (known.schema) return text(JSON.stringify(commandSchema(cmd), null, 2));
  if (known.version) return text(hooks.version);

  const cwd = process.cwd();
  let parsed: ReturnType<typeof parseFlags>;
  try {
    parsed = parseFlags(cmd, cmdArgs, cwd);
  } catch (err) {
    return fail(cmd.name, err);
  }
  const { input, universal, given } = parsed;

  const controller = new AbortController();
  const timeoutSeconds = universal.timeout ?? cmd.timeoutSeconds;
  const ctx: CommandContext = {
    name: cmd.name,
    signal: controller.signal,
    ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1000 } : {}),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) && !universal.noInput,
    quiet: universal.quiet,
    debug: universal.debug,
    given,
    cwd,
    log: (message) => {
      if (!universal.quiet) writeStderr(`${message}\n`);
    },
  };

  let result: CommandResult;
  try {
    result = await withTimeout(cmd, input, ctx, controller, timeoutSeconds);
  } catch (err) {
    return fail(cmd.name, err);
  }
  const env: Envelope = successEnvelope(cmd.name, result);
  if (claimOutput()) await writeStdout(`${asJson ? JSON.stringify(env) : plainText(env, result, universal.quiet)}\n`);
  return 0;
}

function unknownFlagAtRoot(token: string): HoundError {
  return new HoundError("UNKNOWN_COMMAND", `Unknown option "${token}". Run: hound --help`, {
    field: "command",
    received: token,
    retryable: true,
    suggestedFix: "hound --help",
  });
}

/** Runs `cmd` with `input`; rejects with TIMEOUT (and aborts `controller`) after `seconds` when given. */
export async function withTimeout(cmd: Command, input: Record<string, unknown>, ctx: CommandContext, controller: AbortController, seconds?: number): Promise<CommandResult> {
  const running = cmd.run(input, ctx);
  if (!seconds) return running;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new HoundError("TIMEOUT", `${cmd.name} did not finish within ${seconds}s.`, { retryable: true, field: "timeout", received: seconds }));
    }, seconds * 1000);
  });
  running.catch(() => {}); // a late failure after the timeout must not surface as an unhandled rejection
  try {
    return await Promise.race([running, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

