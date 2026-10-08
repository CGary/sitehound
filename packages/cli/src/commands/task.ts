import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Task } from "@sitehound/core";
import { HoundError } from "@sitehound/core/errors";
import { REPO_ROOT, assertSafeName } from "@sitehound/core/paths";
import { defineCommand } from "../framework/types.ts";
import { RUN_FLAGS, executeRun } from "./runner.ts";
import { NAME_RULE, houndCmd } from "./shared.ts";

export const TASKS_DIR = join(REPO_ROOT, "tasks");

async function taskNames(): Promise<string[]> {
  const dirs = existsSync(TASKS_DIR) ? await readdir(TASKS_DIR, { withFileTypes: true }) : [];
  return dirs.filter((d) => d.isDirectory() && existsSync(join(TASKS_DIR, d.name, "index.ts"))).map((d) => d.name).sort();
}

async function loadTask(name: string): Promise<Task> {
  assertSafeName("task", name);
  const file = join(TASKS_DIR, name, "index.ts");
  if (!existsSync(file)) {
    throw new HoundError("TASK_NOT_FOUND", `Task "${name}" not found.`, {
      field: "task",
      received: name,
      allowed: await taskNames(),
      retryable: true,
      suggestedFix: houndCmd("task", "list"),
    });
  }
  const mod = (await import(pathToFileURL(file).href)) as { default: Task };
  return mod.default;
}

export const taskList = defineCommand({
  name: "task.list",
  description: "List the built-in tasks that task run can execute.",
  kind: "read",
  flags: {},
  examples: ["hound task list --json", "hound task list --plain", "hound task run --task snapshot --url https://example.com --json"],
  async run() {
    const tasks = [];
    for (const name of await taskNames()) {
      const task = await loadTask(name);
      tasks.push({ name: task.name, description: task.description, path: join(TASKS_DIR, name, "index.ts") });
    }
    return {
      summary: `${tasks.length} task(s) available.`,
      data: { count: tasks.length, tasks },
      plain: tasks.map((t) => `${t.name.padEnd(16)} ${t.description}`).join("\n") || "No tasks available.",
      next_actions: tasks[0]
        ? [{ command: houndCmd("task", "run", "--task", tasks[0].name, "--url", "<url>"), reason: "Run a task on a page (replace <url>)." }]
        : [],
    };
  },
});

export const taskRun = defineCommand({
  name: "task.run",
  description: "Run a built-in task (snapshot, component, ...) on a URL and write a result.json run directory.",
  kind: "write",
  flags: {
    task: { type: "string", required: true, ...NAME_RULE, description: "Task name (see: hound task list)" },
    ...RUN_FLAGS,
  },
  examples: [
    "hound task run --task snapshot --url https://example.com --json",
    "hound task run --task component --url https://example.com --arg selector=h1 --arg viewports=375,1280 --json",
    "hound task run --task snapshot --url https://example.com --profile work --trace on-failure --json",
  ],
  timeoutSeconds: 600,
  async run(input, ctx) {
    const task = await loadTask(input.task);
    return executeRun(task, task.name, input, ctx);
  },
});

export const taskCommands = [taskList, taskRun];
