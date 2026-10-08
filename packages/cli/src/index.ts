import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  assertSafeName,
  createRunDir,
  deleteProfile,
  listProfiles,
  openSession,
  saveProfile,
  type Task,
  type TaskArgs,
} from "@sitehound/core";

try {
  process.loadEnvFile();
} catch {
  // .env is optional
}

const TASKS_DIR = resolve("tasks");

const HELP = `sitehound — explore, test, analyze and clone websites

Usage:
  pnpm hound login <url> --profile <name>      Log in by hand once; the session is saved
  pnpm hound run <task> <url> [--profile <name>] [--headed] [task flags]
  pnpm hound tasks                             List available tasks
  pnpm hound profiles                          List saved profiles
  pnpm hound forget <profile>                  Delete a saved profile
`;

async function loadTask(name: string): Promise<Task> {
  assertSafeName("task", name);
  const file = join(TASKS_DIR, name, "index.ts");
  if (!existsSync(file)) throw new Error(`Task "${name}" not found in tasks/. Run: pnpm hound tasks`);
  const mod = (await import(pathToFileURL(file).href)) as { default: Task };
  return mod.default;
}

async function login(url: string, profile: string): Promise<void> {
  const session = await openSession({ headless: false });
  try {
    const page = await session.context.newPage();
    await page.goto(url);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Log in in the browser window, then press Enter here to save the session… ");
    rl.close();
    const path = await saveProfile(session.context, profile);
    console.log(`Profile "${profile}" saved (${path}). Keep it private: it grants access to your account.`);
  } finally {
    await session.close();
  }
}

async function run(taskName: string, url: string, profile: string | undefined, headed: boolean, args: TaskArgs) {
  const task = await loadTask(taskName);
  const outDir = await createRunDir(task.name);
  const session = await openSession({ profile, headless: headed ? false : undefined });
  try {
    const page = await session.context.newPage();
    await task.run({ url, page, context: session.context, outDir, args, log: (m) => console.log(`[${task.name}] ${m}`) });
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      profile: { type: "string", short: "p" },
      headed: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, a, b] = positionals;
  const profile = typeof values.profile === "string" ? values.profile : undefined;

  switch (command) {
    case "login":
      if (!a || !profile) throw new Error("Usage: pnpm hound login <url> --profile <name>");
      return login(a, profile);
    case "run": {
      if (!a || !b) throw new Error("Usage: pnpm hound run <task> <url> [--profile <name>]");
      const { profile: _p, headed, help: _h, ...taskArgs } = values;
      return run(a, b, profile, headed === true, taskArgs);
    }
    case "tasks": {
      const dirs = existsSync(TASKS_DIR) ? await readdir(TASKS_DIR, { withFileTypes: true }) : [];
      for (const d of dirs.filter((d) => d.isDirectory() && existsSync(join(TASKS_DIR, d.name, "index.ts")))) {
        const task = await loadTask(d.name);
        console.log(`${task.name.padEnd(16)} ${task.description}`);
      }
      return;
    }
    case "profiles":
      console.log((await listProfiles()).join("\n") || "No profiles saved.");
      return;
    case "forget":
      if (!a) throw new Error("Usage: pnpm hound forget <profile>");
      await deleteProfile(a);
      console.log(`Profile "${a}" deleted.`);
      return;
    default:
      console.log(HELP);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
