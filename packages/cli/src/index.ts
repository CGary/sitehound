import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
  assertSafeName,
  checkSession,
  createRunDir,
  deleteProfile,
  hasProfile,
  listProfiles,
  openSession,
  profileCookieStats,
  readProfileMeta,
  runTask,
  saveProfile,
  saveProfileMeta,
  type Task,
  type TraceMode,
  type TaskContext,
  type TaskResult,
  type TaskArgs,
} from "@sitehound/core";
import { runMcp } from "./mcp.ts";

try {
  process.loadEnvFile();
} catch {
  // .env is optional
}

const TASKS_DIR = resolve("tasks");

const HELP = `sitehound — explore, test, analyze and clone websites

Usage:
  pnpm hound login <url> --profile <name>      Log in by hand once; the session is saved
  pnpm hound run <task> <url> [--profile <name>] [--headed] [--trace[=on-failure]] [task flags]
  pnpm hound exec <file.ts> <url> [--profile <name>] [--headed] [--trace[=on-failure]] [flags]
                                               Run a single-file script (no package, no install)
  pnpm hound check <profile>                   Is the saved session still valid? (exit 0 valid, 2 expired, 3 unknown)
  pnpm hound mcp [--profile <name>] [--headed] [-- <@playwright/mcp flags>]
                                               Playwright MCP server over stdio, preloaded with a profile
  pnpm hound tasks                             List available tasks
  pnpm hound profiles                          List saved profiles
  pnpm hound forget <profile>                  Delete a saved profile

Every run/exec writes result.json (status, checks, console/page errors, failed requests,
session state, files) into its run directory under .hound/runs/. Exit code: 0 pass, 1 fail/error.
Task flags go after the URL: --selector h1 or --selector=h1. A flag with no value is true.
--trace (or --trace on) records a Playwright trace and keeps only a redacted copy in the run
directory: debug-trace.zip (open with: pnpm exec playwright show-trace <file>) and steps.json (ordered
actions, console errors). --trace on-failure keeps them only when the run is not a pass. The raw
trace is deleted; cookies, auth headers, bodies, form values and URL queries are removed.

exec scripts (recommended location: .hound/scripts/, git-ignored) need no imports. The default
export is an async function (ctx) => TaskResult | void, or { name?, description?, run }.
  ctx = {
    url, page, context,      Playwright Page / BrowserContext, already open on a session
    outDir,                  private directory; write all output here
    args,                    extra --flags,  log(message),
    check(name, ok, detail?) record an assertion (returns ok); a failed check fails the run
  }
  return { status?: "pass" | "fail", summary?: string, data?: unknown }
For clean page content use captureText() (@sitehound/capture) in tasks; in scripts, read
page.evaluate(() => document.body.innerText) or page.locator("body").ariaSnapshot().
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
    const landingUrl = page.url();
    const path = await saveProfile(session.context, profile);
    await saveProfileMeta(profile, url, landingUrl);
    console.log(`Profile "${profile}" saved (${path}). Keep it private: it grants access to your account.`);
  } finally {
    await session.close();
  }
}

async function execute(task: Pick<Task, "name" | "run">, outDir: string, url: string, profile: string | undefined, headed: boolean, args: TaskArgs, trace: TraceMode) {
  const result = await runTask({ task, url, profile, headed, args, outDir, trace });
  // Error text can embed page content (element HTML, accessible names): keep it in result.json only.
  const line = result.status === "error" ? "see result.json for the error" : (result.summary.split("\n")[0] ?? "").slice(0, 120);
  const summary = line ? ` - ${line}` : "";
  console.log(`${result.status}${summary}`);
  console.log(`result: ${join(outDir, "result.json")}`);
  if (result.trace?.file) console.log(`trace: ${join(outDir, result.trace.file)} (steps: ${join(outDir, result.trace.steps ?? "steps.json")})`);
  else if (result.trace?.error) console.log("trace: not produced (see result.json)");
  if (result.session?.state === "expired") {
    console.log(`warning: session "${profile}" looks expired (${result.session.reason}). Re-run: pnpm hound login <url> --profile ${profile}`);
  }
  process.exitCode = result.status === "pass" ? 0 : 1;
}

async function run(taskName: string, url: string, profile: string | undefined, headed: boolean, args: TaskArgs, trace: TraceMode) {
  const task = await loadTask(taskName);
  await execute(task, await createRunDir(task.name), url, profile, headed, args, trace);
}

type ScriptFn = (ctx: TaskContext) => Promise<TaskResult | void>;

async function exec(file: string, url: string, profile: string | undefined, headed: boolean, args: TaskArgs, trace: TraceMode) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) throw new Error(`Script not found: ${file}`);
  if (![".ts", ".js", ".mjs"].includes(extname(path))) throw new Error("Script must be a .ts, .js or .mjs file.");
  const mod = (await import(pathToFileURL(path).href)) as { default?: ScriptFn | Partial<Task> };
  const def = mod.default;
  const fn = typeof def === "function" ? def : def?.run?.bind(def);
  if (!fn) throw new Error("Script must default-export an async function (ctx) => ... or { run }.");
  const base = basename(path, extname(path)).replace(/[^a-z0-9._-]/gi, "-").replace(/\.{2,}/g, "-").replace(/^[^a-z0-9]+/i, "").slice(0, 50) || "script";
  const task = { name: (typeof def === "object" && def.name) || base, run: fn };
  await execute(task, await createRunDir(`exec-${base}`), url, profile, headed, args, trace);
}

async function check(profile: string): Promise<void> {
  if (!hasProfile(profile)) throw new Error(`Profile "${profile}" not found. Create it with: pnpm hound login <url> --profile ${profile}`);
  const meta = readProfileMeta(profile);
  if (!meta) throw new Error(`No session info for "${profile}". Re-run: pnpm hound login <url> --profile ${profile}`);
  const session = await openSession({ profile });
  try {
    const page = await session.context.newPage();
    await page.goto(meta.landingUrl, { waitUntil: "load" }).catch(() => {});
    const { state, reason } = await checkSession(page, meta);
    const { totalCookies, expiredCookies } = profileCookieStats(profile);
    console.log(`${state}: ${reason}`);
    console.log(`cookies: ${expiredCookies} expired of ${totalCookies}`);
    process.exitCode = state === "valid" ? 0 : state === "expired" ? 2 : 3;
  } finally {
    await session.close();
  }
}

/**
 * Parses argv into positionals and flags. Accepts `--key value`, `--key=value` and bare
 * `--key` (true). Known boolean flags never consume the next token. Everything after a
 * standalone `--` is passed through untouched (used by `mcp`).
 */
const BOOLEAN_FLAGS = new Set(["headed", "help"]);
const SHORT_FLAGS: Record<string, string> = { p: "profile", h: "help" };
/** Flags whose value is one of a fixed set: any other next token is NOT consumed (so `--trace <url>` works). */
const ENUM_FLAGS: Record<string, string[]> = { trace: ["on", "off", "on-failure"] };

function parseTraceMode(value: string | boolean | undefined): TraceMode {
  if (value === undefined || value === "off") return "off";
  if (value === true || value === "on") return "on";
  if (value === "on-failure") return "on-failure";
  throw new Error("--trace must be on, off or on-failure (default with no value: on)");
}

function parseCli(argv: string[]): { positionals: string[]; values: TaskArgs; passthrough: string[] } {
  const positionals: string[] = [];
  const values: TaskArgs = {};
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const passthrough = sep === -1 ? [] : argv.slice(sep + 1);
  for (let i = 0; i < own.length; i++) {
    const token = own[i]!;
    const long = token.match(/^--([^=]+)(?:=(.*))?$/s);
    const short = token.match(/^-([a-z])$/i);
    const key = long?.[1] ?? (short ? SHORT_FLAGS[short[1]!] ?? short[1]! : undefined);
    if (!key) {
      positionals.push(token);
      continue;
    }
    if (long?.[2] !== undefined) {
      values[key] = long[2];
      continue;
    }
    const next = own[i + 1];
    const allowed = ENUM_FLAGS[key];
    if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("-") && (!allowed || allowed.includes(next))) {
      values[key] = next;
      i++;
    } else {
      values[key] = true;
    }
  }
  return { positionals, values, passthrough };
}

async function main(): Promise<void> {
  const { values, positionals, passthrough } = parseCli(process.argv.slice(2));
  const [command, a, b] = positionals;
  const profile = typeof values.profile === "string" ? values.profile : undefined;

  switch (command) {
    case "login":
      if (!a || !profile) throw new Error("Usage: pnpm hound login <url> --profile <name>");
      return login(a, profile);
    case "run": {
      if (!a || !b) throw new Error("Usage: pnpm hound run <task> <url> [--profile <name>]");
      const { profile: _p, headed, help: _h, trace, ...taskArgs } = values;
      return run(a, b, profile, headed === true, taskArgs, parseTraceMode(trace));
    }
    case "exec": {
      if (!a || !b) throw new Error("Usage: pnpm hound exec <file.ts> <url> [--profile <name>]");
      const { profile: _p, headed, help: _h, trace, ...scriptArgs } = values;
      return exec(a, b, profile, headed === true, scriptArgs, parseTraceMode(trace));
    }
    case "mcp":
      return runMcp({ profile, headed: values.headed === true, extraArgs: passthrough });
    case "check":
      if (!a) throw new Error("Usage: pnpm hound check <profile>");
      return check(a);
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
