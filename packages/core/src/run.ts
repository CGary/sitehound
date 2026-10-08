import { chmod, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openSession } from "./browser.ts";
import { ensurePrivateDir } from "./paths.ts";
import { pickSite, readProfileMeta } from "./profiles.ts";
import { redactData, redactText, stripUrl } from "./redact.ts";
import { checkSession, profileCookieStats, type SessionCheck, type CookieStats } from "./session.ts";
import type { Task, TaskArgs, TaskResult } from "./task.ts";
import { cleanTrace, type TraceRedactions } from "./trace.ts";

export type TraceMode = "off" | "on" | "on-failure";

export interface TraceInfo {
  file?: string;
  steps?: string;
  actions?: number;
  redactions?: TraceRedactions;
  /** Short redacted reason when no clean trace could be produced. */
  error?: string;
}

export interface RunResult {
  task: string;
  url: string;
  /** Profile name only. */
  profile?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: "pass" | "fail" | "error";
  summary: string;
  checks: { name: string; ok: boolean; detail?: string }[];
  data: unknown;
  error?: { message: string };
  consoleErrors: { text: string; location?: string }[];
  pageErrors: { message: string }[];
  failedRequests: { method: string; url: string; status?: number; failure?: string }[];
  session?: SessionCheck & Partial<CookieStats>;
  /** Present only when tracing was requested and a clean trace was produced or failed. */
  trace?: TraceInfo;
  files: string[];
}

export interface RunOptions {
  task: Pick<Task, "name" | "run">;
  url: string;
  profile?: string;
  /** Show the browser window. */
  headed?: boolean;
  args?: TaskArgs;
  outDir: string;
  /** Record a Playwright trace and keep a redacted copy (`debug-trace.zip`, `steps.json`). Default "off". */
  trace?: TraceMode;
  log?(message: string): void;
}

const MAX_ENTRIES = 200;
const TRACE_FILE = "debug-trace.zip";
const TRACE_STEPS = "steps.json";

/**
 * Stops tracing into a raw zip inside a private temp dir, writes the redacted derivative into
 * `outDir`, and ALWAYS deletes the raw zip. On failure no partial output is kept.
 */
async function finishTrace(
  context: { tracing: { stop(opts: { path: string }): Promise<void> } },
  outDir: string,
  mode: TraceMode,
  status: RunResult["status"],
): Promise<TraceInfo | undefined> {
  const rawDir = join(outDir, ".raw");
  try {
    await ensurePrivateDir(rawDir);
    const raw = join(rawDir, "raw.zip");
    await context.tracing.stop({ path: raw });
    await chmod(raw, 0o600);
    if (mode === "on-failure" && status === "pass") return undefined;
    const stagedZip = join(rawDir, TRACE_FILE);
    const stagedSteps = join(rawDir, TRACE_STEPS);
    const { actions, redactions } = await cleanTrace(raw, stagedZip, stagedSteps);
    await rename(stagedZip, join(outDir, TRACE_FILE));
    try {
      await rename(stagedSteps, join(outDir, TRACE_STEPS));
    } catch (err) {
      await rm(join(outDir, TRACE_FILE), { force: true });
      throw err;
    }
    return { file: TRACE_FILE, steps: TRACE_STEPS, actions, redactions };
  } catch (err) {
    await Promise.all([rm(join(outDir, TRACE_FILE), { force: true }), rm(join(outDir, TRACE_STEPS), { force: true })]);
    return { error: redactText(err instanceof Error ? err.message : String(err), 200) };
  } finally {
    await rm(rawDir, { recursive: true, force: true });
  }
}

/**
 * Runs a task in a fresh session and always writes `result.json` into `outDir`.
 * Only redacted facts are recorded: no headers, cookies, bodies, or URL queries.
 */
export async function runTask(opts: RunOptions): Promise<RunResult> {
  const { task, url, profile, outDir } = opts;
  const started = Date.now();
  const result: RunResult = {
    task: task.name,
    url: stripUrl(url),
    profile,
    startedAt: new Date(started).toISOString(),
    finishedAt: "",
    durationMs: 0,
    status: "pass",
    summary: "",
    checks: [],
    data: null,
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    files: [],
  };
  const push = <T>(list: T[], item: T) => void (list.length < MAX_ENTRIES && list.push(item));

  const fail = (err: unknown) => {
    result.status = "error";
    result.error = { message: redactText(err instanceof Error ? err.message : String(err)) };
    result.summary = result.error.message;
  };
  let returned: TaskResult | void = undefined;
  let session: Awaited<ReturnType<typeof openSession>> | undefined;
  const traceMode = opts.trace ?? "off";
  let tracing = false;
  try {
    session = await openSession({ profile, headless: opts.headed ? false : undefined });
  } catch (err) {
    fail(err);
  }
  if (session) {
    try {
      const { context } = session;
      if (traceMode !== "off") {
        try {
          await context.tracing.start({ screenshots: false, snapshots: true, sources: false });
          tracing = true;
        } catch (err) {
          result.trace = { error: redactText(err instanceof Error ? err.message : String(err), 200) };
        }
      }
      context.on("console", (m) => {
        if (m.type() === "error") {
          const loc = m.location().url;
          push(result.consoleErrors, { text: redactText(m.text(), 300), ...(loc ? { location: stripUrl(loc) } : {}) });
        }
      });
      context.on("weberror", (e) => push(result.pageErrors, { message: redactText(e.error().message, 300) }));
      context.on("requestfailed", (r) =>
        push(result.failedRequests, {
          method: r.method(),
          url: stripUrl(r.url()),
          failure: redactText(r.failure()?.errorText ?? "failed", 100),
        }),
      );
      context.on("response", (r) => {
        if (r.status() >= 400) {
          push(result.failedRequests, { method: r.request().method(), url: stripUrl(r.url()), status: r.status() });
        }
      });

      const page = await context.newPage().catch((err: unknown) => void fail(err));
      if (!page) throw new Error("could not open a page");
      const prefix = `[${task.name}]`;
      try {
        returned = await task.run({
          url,
          page,
          context,
          outDir,
          args: opts.args ?? {},
          log: opts.log ?? ((m) => console.log(`${prefix} ${m}`)),
          check(name, ok, detail) {
            result.checks.push({ name, ok, ...(detail !== undefined && { detail: redactText(detail) }) });
            return ok;
          },
        });
      } catch (err) {
        fail(err);
      }

      if (result.status !== "error") {
        const failedCheck = result.checks.some((c) => !c.ok);
        // A failed check always fails the run; a task can only downgrade pass to fail.
        result.status = failedCheck || returned?.status === "fail" ? "fail" : "pass";
        result.summary = redactText(returned?.summary ?? "");
        result.data = redactData(returned?.data ?? null);
      }

      if (profile) {
        result.session = { ...(await checkSession(page, pickSite(readProfileMeta(profile), page.url()))), ...profileCookieStats(profile) };
        if (result.session.state === "expired" && result.status === "pass") {
          result.status = "fail";
          result.summary = `session looks expired: ${result.session.reason}`;
        }
      }
      if (result.status !== "pass") {
        try {
          const shot = join(outDir, "failure.png");
          await page.screenshot({ path: shot, timeout: 5000 });
          await chmod(shot, 0o600);
        } catch {
          // the page may be closed or unresponsive
        }
      }
    } catch (err) {
      if (result.status !== "error") fail(err);
    } finally {
      if (tracing) {
        const info = await finishTrace(session.context, outDir, traceMode, result.status);
        if (info) result.trace = info;
      }
      await session.close().catch(() => {});
    }
  }

  result.finishedAt = new Date().toISOString();
  result.durationMs = Date.now() - started;
  const names = new Set([...(await readdir(outDir)), "result.json"]);
  result.files = [...names].sort();

  let json: string;
  try {
    json = JSON.stringify(result, null, 2);
  } catch {
    json = JSON.stringify({ ...result, data: "[unserializable]" }, null, 2);
  }
  await writeFile(join(outDir, "result.json"), json, { mode: 0o600 });
  return result;
}
