import { existsSync, statSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Task, TaskContext, TaskResult } from "@sitehound/core";
import { HoundError } from "@sitehound/core/errors";
import { defineCommand } from "../framework/types.ts";
import { SESSION_FLAG, callSession, sessionCmd } from "./browser-shared.ts";
import { OUTPUT_FLAGS, checkOutputPath } from "./output.ts";
import { RUN_FLAGS, executeRun } from "./runner.ts";
import { renderScript } from "./script-export.ts";
import { NAME_RULE, givenInput, readFileAction } from "./shared.ts";

type ScriptFn = (ctx: TaskContext) => Promise<TaskResult | void>;

export const scriptRun = defineCommand({
  name: "script.run",
  description: "Run a single-file script (default export: async (ctx) => result) on a URL; failed ctx.check() fails the run.",
  kind: "write",
  flags: {
    file: { type: "path", required: true, description: "Script file (.ts, .js or .mjs); relative paths resolve against the current directory" },
    ...RUN_FLAGS,
  },
  examples: [
    "hound script run --file .hound/scripts/home-h1.ts --url https://example.com --json",
    "hound script run --file ./checks/login.ts --url https://example.com --profile work --trace on-failure --json",
    "hound script run --file ./extract.ts --url https://example.com --arg limit=10 --display headed --json",
  ],
  timeoutSeconds: 600,
  async run(input, ctx) {
    const path: string = input.file;
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new HoundError("FILE_NOT_FOUND", `Script not found: ${path}`, { field: "file", received: path, retryable: true });
    }
    if (![".ts", ".js", ".mjs"].includes(extname(path))) {
      throw new HoundError("INVALID_ARGUMENT", "Script must be a .ts, .js or .mjs file.", { field: "file", received: path, allowed: [".ts", ".js", ".mjs"], retryable: true });
    }
    const mod = (await import(pathToFileURL(path).href).catch((err: unknown) => {
      throw new HoundError("VALIDATION_FAILED", `Could not load the script: ${err instanceof Error ? err.message.split("\n")[0] : "import error"}`, { field: "file", received: path });
    })) as { default?: ScriptFn | Partial<Task> };
    const def = mod.default;
    const fn = typeof def === "function" ? def : def?.run?.bind(def);
    if (!fn) {
      throw new HoundError("VALIDATION_FAILED", "Script must default-export an async function (ctx) => ... or { run }.", { field: "file", received: path });
    }
    const base = basename(path, extname(path)).replace(/[^a-z0-9._-]/gi, "-").replace(/\.{2,}/g, "-").replace(/^[^a-z0-9]+/i, "").slice(0, 50) || "script";
    const task = { name: (typeof def === "object" && def.name) || base, run: fn };
    return executeRun(task, `exec-${base}`, input, ctx);
  },
});

export const scriptExport = defineCommand({
  name: "script.export",
  description:
    "Turn what was done in a running browser session (navigate, click, fill, type, select, check, drag, upload, download, waits, tabs, resize, emulate) into a test script for script run. Elements get stable locators (test id, role + name, label, placeholder, text, CSS; TODO comments where ambiguous); typed values, prompt answers and upload paths are never recorded and become --arg parameters; URL paths and waited-for texts become checks. Export before closing the session: the action log lives in its memory (last 500 actions).",
  kind: "write",
  flags: {
    ...SESSION_FLAG,
    ...OUTPUT_FLAGS,
    output: {
      ...OUTPUT_FLAGS.output!,
      pattern: "\\.ts$",
      patternHint: "a .ts file (the export is TypeScript; script run loads it)",
      description: "Write the script to this .ts file instead of the session's runs directory (relative paths resolve against the current directory; refuses directories and symlinks)",
    },
    name: { type: "string", ...NAME_RULE, description: "Test name inside the script and in result.json (default export-<session-name>)" },
    "include-query": { type: "boolean", description: "Keep query strings and fragments in exported URLs (they can hold tokens or personal data). Default: origin + path, token-like path segments masked" },
  },
  examples: [
    "hound script export --session-name shop --json",
    "hound script export --session-name shop --output ./checkout.test.ts --name checkout --json",
    "hound script export --session-name shop --output ./checkout.test.ts --if-exists overwrite --include-query --json",
  ],
  async run(input, ctx) {
    const s: string = input["session-name"];
    if (input.output) await checkOutputPath(this, givenInput(input, ctx), input.output, input["if-exists"]);
    const log = await callSession(ctx, s, "actions", { includeQuery: input["include-query"] === true });
    if (log.actions.length === 0) {
      throw new HoundError("VALIDATION_FAILED", `Nothing to export: session "${s}" has no recorded actions yet (navigate, click, fill, wait, ... first).`, {
        field: "session-name",
        received: s,
        retryable: true,
        suggestedFix: sessionCmd("page", "navigate", s, "--url", "<url>"),
      });
    }
    const { browserSessionRunsDir, ensurePrivateDir, writeOutputSafe } = await import("@sitehound/core");
    const generatedAt = new Date().toISOString();
    const file: string = input.output ?? join(await ensurePrivateDir(browserSessionRunsDir(s)), `export-${generatedAt.replace(/[:.]/g, "-")}.ts`);
    const rendered = renderScript(log, { name: input.name ?? `export-${s}`.slice(0, 64), file, generatedAt });
    if (input.output) await writeOutputSafe(file, rendered.code, input["if-exists"] === "overwrite");
    else {
      await writeFile(file, rendered.code, { mode: 0o600, flag: "wx" });
      await chmod(file, 0o600);
    }
    const params = rendered.params.map((p) => p.name);
    return {
      summary: `Exported ${rendered.steps} step(s) to a script${params.length ? ` with ${params.length} required --arg value(s)` : ""}${rendered.ambiguous ? `; ${rendered.ambiguous} locator(s) need checking (TODO verify locator)` : ""}${log.dropped ? `; the first ${log.dropped} action(s) were no longer in the log` : ""}.`,
      data: {
        file,
        steps: rendered.steps,
        ambiguous: rendered.ambiguous,
        params,
        paramsInfo: rendered.params,
        startUrl: rendered.startUrl,
        ...(log.session.profile && { profile: log.session.profile }),
        ...(log.dropped && { dropped: log.dropped }),
      },
      plain: file,
      next_actions: [
        { command: rendered.runCommand, reason: `Replay the export as a test${params.length ? " (replace each <name> with the value to type; never paste secrets into shared logs)" : ""}.` },
        readFileAction(file, "Review the script (locators, TODO comments, checks)."),
      ],
    };
  },
});

export const scriptCommands = [scriptRun, scriptExport];
