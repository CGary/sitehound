import { join } from "node:path";
import type { RunResult, Task, TaskArgs } from "@sitehound/core";
import { HoundError } from "@sitehound/core/errors";
import { hasProfile } from "@sitehound/core/profiles";
import type { CommandContext, CommandResult, FlagSpec, Input, NextAction } from "../framework/types.ts";
import { interceptExit, setRun } from "../framework/lifecycle.ts";
import { NAME_RULE, houndCmd, parseUrlFlag, readFileAction, readFileCommand } from "./shared.ts";

/** Flags shared by task.run and script.run. */
export const RUN_FLAGS: Record<string, FlagSpec> = {
  url: { type: "string", required: true, maxLength: 2048, description: "Page URL to open (http/https)" },
  profile: { type: "string", ...NAME_RULE, description: "Saved login to load (see: hound profile list)" },
  display: { type: "enum", values: ["headless", "headed"], default: "headless", description: "headed shows the browser window" },
  trace: { type: "enum", values: ["off", "on", "on-failure"], default: "off", description: "Keep a redacted trace (steps.json, debug-trace.zip); on-failure keeps it only if the run is not a pass" },
  arg: { type: "string", repeatable: true, maxLength: 2000, description: "Extra task/script argument as key=value (becomes ctx.args)" },
};

/** `--arg key=value` list to ctx.args. */
export function parseArgs(pairs: string[]): TaskArgs {
  const args: TaskArgs = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const key = at === -1 ? pair : pair.slice(0, at);
    if (at === -1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(key) || key === "__proto__") {
      throw new HoundError("INVALID_ARGUMENT", `--arg must look like key=value (key: letters, digits, "_", ".", "-"), got "${pair.slice(0, 80)}".`, {
        field: "arg",
        received: pair.slice(0, 80),
        retryable: true,
      });
    }
    args[key] = pair.slice(at + 1);
  }
  return args;
}

const firstLine = (text: string, max = 120): string => (text.split("\n")[0] ?? "").slice(0, max);

/** Runs a task-shaped unit in a fresh run dir and maps the RunResult to the command envelope. */
export async function executeRun(task: Pick<Task, "name" | "run">, dirName: string, input: Input, ctx: CommandContext): Promise<CommandResult> {
  const url = parseUrlFlag("url", input.url).href;
  const args = parseArgs(input.arg ?? []);
  const profile: string | undefined = input.profile;
  if (profile && !hasProfile(profile)) {
    throw new HoundError("PROFILE_NOT_FOUND", `Profile "${profile}" not found.`, {
      field: "profile",
      received: profile,
      suggestedFix: houndCmd("profile", "login", "--profile", profile, "--url", "<url>"),
    });
  }
  const { createRunDir, runTask } = await import("@sitehound/core");
  const outDir = await createRunDir(dirName);
  setRun({ active: true, runDir: outDir });
  // User code must not be able to end the process before the envelope is written.
  const restoreExit = interceptExit();
  let result: RunResult;
  try {
    result = await runTask({
      task,
      url,
      profile,
      headed: input.display === "headed",
      args,
      outDir,
      trace: input.trace,
      log: (message) => ctx.log(`[${task.name}] ${message}`),
    });
  } finally {
    restoreExit();
  }
  const abs = (f: string) => join(outDir, f);
  const resultFile = abs("result.json");
  const stepsFile = result.trace?.steps ? abs(result.trace.steps) : undefined;
  const data = {
    ...result,
    runDir: outDir,
    resultFile,
    files: result.files.map(abs),
    ...(result.trace && { trace: { ...result.trace, ...(result.trace.file && { file: abs(result.trace.file) }), ...(stepsFile && { steps: stepsFile }) } }),
  } satisfies RunResult & { runDir: string; resultFile: string };

  if (result.status !== "pass") {
    const readPath = stepsFile ?? resultFile;
    const failedChecks = result.checks.filter((c) => !c.ok).length;
    const expired = result.session?.state === "expired";
    throw new HoundError(
      result.status === "error" ? "RUN_ERROR" : "RUN_FAILED",
      result.status === "error"
        ? "The run ended with an error. Read data.error and result.json for the redacted message."
        : `The run failed${failedChecks ? ` (${failedChecks} failed check(s))` : ""}${expired ? `; session looks expired: ${result.session?.reason}` : ""}. ${firstLine(result.summary, 160)}`.trim(),
      { retryable: false, suggestedFix: readFileCommand(readPath), data },
    );
  }

  const next: NextAction[] = [];
  const text = data.files.find((f) => f.endsWith("/text.md"));
  if (text) next.push(readFileAction(text, "Read the captured page text."));
  if (stepsFile) next.push(readFileAction(stepsFile, "Read the redacted action trace."));
  if (!next.length) next.push(readFileAction(resultFile, "Read the full run result."));
  const line = firstLine(result.summary);
  return {
    summary: `${task.name}: pass${line ? ` - ${line}` : ""}`,
    data,
    next_actions: next.slice(0, 3),
    plain: `pass${line ? ` - ${line}` : ""}\nresult: ${resultFile}${stepsFile ? `\nsteps: ${stepsFile}` : ""}`,
  };
}

