import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { RUNS_DIR, assertSafeName, ensurePrivateDir } from "./paths.ts";

export type TaskArgs = Record<string, string | boolean | undefined>;

export interface TaskContext {
  url: string;
  page: Page;
  context: BrowserContext;
  /** Private, git-ignored directory for this run's output. */
  outDir: string;
  /** Extra `--key value` flags passed after the URL. */
  args: TaskArgs;
  log(message: string): void;
  /** Records a named assertion in result.json and returns `ok`. Any failed check makes the run fail. */
  check(name: string, ok: boolean, detail?: string): boolean;
}

/** What a task may return. Written to result.json as status / summary / data. */
export interface TaskResult {
  /** Overrides the status derived from checks. */
  status?: "pass" | "fail";
  summary?: string;
  /** Any JSON-serializable data worth keeping. */
  data?: unknown;
}

export interface Task {
  name: string;
  description: string;
  run(ctx: TaskContext): Promise<TaskResult | void>;
}

export const defineTask = (task: Task): Task => task;

export async function createRunDir(task: string): Promise<string> {
  assertSafeName("task", task);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return ensurePrivateDir(join(RUNS_DIR, task, stamp));
}
