import { HoundError, USAGE_ERROR_CODES, isHoundError, type ErrorCode } from "@sitehound/core/errors";
import type { CommandResult, NextAction } from "./types.ts";

export interface SuccessEnvelope {
  ok: true;
  command: string;
  summary: string;
  data: unknown;
  next_actions?: NextAction[];
}

export interface ErrorEnvelope {
  ok: false;
  command: string;
  error: { code: ErrorCode; message: string; field?: string; received?: unknown; allowed?: readonly string[] };
  retryable: boolean;
  suggested_fix?: { command: string };
  data?: unknown;
  /** Only with --debug. */
  stack?: string;
}

export type Envelope = SuccessEnvelope | ErrorEnvelope;

const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set([
  "UNKNOWN_COMMAND",
  "INVALID_ARGUMENT",
  "MISSING_REQUIRED_FLAG",
  "INVALID_ENUM",
  "TIMEOUT",
  "NETWORK_ERROR",
  "BROWSER_CRASHED",
]);

export const exitCodeFor = (code: ErrorCode): number => (USAGE_ERROR_CODES.has(code) ? 2 : 1);

/** Maps anything thrown to a HoundError; unexpected exceptions become INTERNAL_ERROR (message only). */
export function toHoundError(err: unknown): HoundError {
  if (isHoundError(err)) return err;
  // An error that crossed a boundary (e.g. rebuilt from JSON) may not be an instance.
  const o = err as { name?: string; code?: ErrorCode; message?: string; details?: object } | null;
  if (o && o.name === "HoundError" && typeof o.code === "string") return HoundError.fromJSON(o as { code: ErrorCode; message: string });
  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new HoundError("INTERNAL_ERROR", message || "Unexpected error");
  if (err instanceof Error && err.stack) wrapped.stack = err.stack;
  return wrapped;
}

function limit(value: unknown): unknown {
  if (typeof value === "string" && value.length > 300) return `${value.slice(0, 300)}…`;
  return value;
}

export function successEnvelope(command: string, result: CommandResult): SuccessEnvelope {
  const env: SuccessEnvelope = { ok: true, command, summary: result.summary, data: result.data ?? {} };
  if (result.next_actions?.length) env.next_actions = result.next_actions.slice(0, 3);
  return env;
}

export function errorEnvelope(command: string, err: HoundError, debug: boolean): ErrorEnvelope {
  const d = err.details;
  const env: ErrorEnvelope = {
    ok: false,
    command,
    error: {
      code: err.code,
      message: err.message,
      ...(d.field !== undefined && { field: d.field }),
      ...(d.received !== undefined && { received: limit(d.received) }),
      ...(d.allowed !== undefined && { allowed: d.allowed }),
    },
    retryable: d.retryable ?? RETRYABLE_BY_DEFAULT.has(err.code),
  };
  if (d.suggestedFix) env.suggested_fix = { command: d.suggestedFix };
  if (d.data !== undefined) env.data = d.data;
  if (debug && err.stack) env.stack = err.stack;
  return env;
}

/** Short human rendering for --plain / TTY. Errors go to stderr, results to stdout. */
export function plainText(env: Envelope, result?: CommandResult, quiet = false): string {
  if (env.ok) {
    const lines = [result?.plain ?? env.summary];
    if (!quiet) for (const a of env.next_actions ?? []) lines.push(`next: ${a.command}  (${a.reason})`);
    return lines.join("\n");
  }
  const lines = [`error [${env.error.code}]: ${env.error.message}`];
  if (env.suggested_fix) lines.push(`fix: ${env.suggested_fix.command}`);
  if (env.stack) lines.push(env.stack);
  return lines.join("\n");
}
