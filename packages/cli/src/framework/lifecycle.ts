/**
 * Process-level guarantee: whatever happens (uncaught exception, unhandled rejection, SIGINT/SIGTERM, user code
 * calling process.exit), the CLI writes exactly ONE final output and exits 0, 1 or 2. Never 130, never silence.
 * Every final write goes through `claimOutput()`, which succeeds once.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { HoundError, type ErrorCode } from "@sitehound/core/errors";
import { errorEnvelope, plainText } from "./envelope.ts";
import { writeStderr, writeStdoutNow } from "./stdio.ts";

/** The real process.exit, captured before anything can replace it. */
export const realExit: (code?: number) => never = process.exit.bind(process);

const state = {
  claimed: false,
  command: "hound",
  asJson: !process.stdout.isTTY,
  debug: false,
  inRun: false,
  runDir: undefined as string | undefined,
};

/** Records how the current command renders its final output (call as soon as it is known). */
export function configure(patch: { command?: string; asJson?: boolean; debug?: boolean }): void {
  if (patch.command !== undefined) state.command = patch.command;
  if (patch.asJson !== undefined) state.asJson = patch.asJson;
  if (patch.debug !== undefined) state.debug = patch.debug;
}

/** Marks that a task/script run is in progress (errors become RUN_ERROR), optionally with its run directory. */
export function setRun(patch: { active?: boolean; runDir?: string }): void {
  if (patch.active !== undefined) state.inRun = patch.active;
  if (patch.runDir !== undefined) state.runDir = patch.runDir;
}

/** True exactly once: the caller that gets true owns the process's final output. */
export function claimOutput(): boolean {
  if (state.claimed) return false;
  state.claimed = true;
  return true;
}

const firstLine = (text: string, max = 300): string =>
  (text.split("\n")[0] ?? "").replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, "$1").slice(0, max);

function emergencyError(reason: unknown, signal?: string): HoundError {
  const code: ErrorCode = state.inRun ? "RUN_ERROR" : "INTERNAL_ERROR";
  const data = state.runDir ? { runDir: state.runDir } : undefined;
  const detail = reason instanceof Error ? reason.message : String(reason);
  const message = signal
    ? `Interrupted by ${signal}.${state.inRun ? " The run did not finish; its directory may hold partial output." : ""}`
    : `${state.inRun ? "The run ended with an uncaught error" : "Unexpected error"}: ${firstLine(detail) || "unknown"}`;
  const err = new HoundError(code, message, { retryable: false, ...(data && { data }) });
  if (state.debug && reason instanceof Error && reason.stack) err.stack = reason.stack;
  return err;
}

/** The raw trace is never kept: remove it if the process dies mid-run. */
function dropRawTrace(): void {
  if (!state.runDir) return;
  try {
    rmSync(join(state.runDir, ".raw"), { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function emit(err: HoundError): void {
  const env = errorEnvelope(state.command, err, state.debug);
  if (state.asJson) writeStdoutNow(`${JSON.stringify(env)}\n`);
  else writeStderr(`${plainText(env)}\n`);
}

function abort(reason: unknown, signal?: string): void {
  if (!claimOutput()) {
    // A result was already written: keep its exit code; just note the late failure on stderr.
    writeStderr(`late ${signal ? `signal ${signal}` : "error"} ignored: ${firstLine(reason instanceof Error ? reason.message : String(reason), 200)}\n`);
    return;
  }
  dropRawTrace();
  emit(emergencyError(reason, signal));
  realExit(1);
}

/** Installs the process-level handlers. Call once, before running a command. */
export function installProcessGuards(): void {
  process.on("uncaughtException", (err) => abort(err));
  process.on("unhandledRejection", (reason) => abort(reason));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => abort(undefined, signal));
  // Last line of defense: the loop drained, or something called the real exit, before any output was written.
  process.on("exit", () => {
    if (state.claimed) return;
    state.claimed = true;
    dropRawTrace();
    emit(new HoundError(state.inRun ? "RUN_ERROR" : "INTERNAL_ERROR", "The process ended before producing a result.", { retryable: false, ...(state.runDir && { data: { runDir: state.runDir } }) }));
    process.exitCode = 1;
  });
}

/**
 * While user code (a task or script) runs, `process.exit(n)` throws a RUN_ERROR instead of killing the process
 * before the envelope is written. Returns the function that restores the original.
 */
export function interceptExit(): () => void {
  const original = process.exit;
  process.exit = ((code?: number | string | null) => {
    throw new HoundError("RUN_ERROR", `script called process.exit(${code ?? 0})`, { retryable: false });
  }) as typeof process.exit;
  return () => {
    process.exit = original;
  };
}
