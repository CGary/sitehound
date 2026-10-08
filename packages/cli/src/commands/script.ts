import { existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { Task, TaskContext, TaskResult } from "@sitehound/core";
import { HoundError } from "@sitehound/core/errors";
import { defineCommand } from "../framework/types.ts";
import { RUN_FLAGS, executeRun } from "./runner.ts";

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

export const scriptCommands = [scriptRun];
