import { chromium, type Browser, type BrowserContext } from "playwright";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOUND_HOME, ensurePrivateDir } from "./paths.ts";
import { hasProfile, profilePath } from "./profiles.ts";

export interface SessionOptions {
  /** Saved login to load. Omit for anonymous browsing. */
  profile?: string;
  headless?: boolean;
}

export interface Session {
  browser: Browser;
  context: BrowserContext;
  close(): Promise<void>;
}

export const defaultHeadless = (): boolean => process.env.HOUND_HEADLESS !== "false";

export async function openSession({ profile, headless = defaultHeadless() }: SessionOptions = {}): Promise<Session> {
  if (profile && !hasProfile(profile)) {
    throw new Error(`Profile "${profile}" not found. Create it with: pnpm hound login <url> --profile ${profile}`);
  }
  // Raw trace chunks go to a private per-session dir (never the system temp dir), removed on close.
  const tracesRoot = await ensurePrivateDir(join(HOUND_HOME, "tmp", "traces"));
  await sweepStale(tracesRoot);
  const tracesDir = await ensurePrivateDir(join(tracesRoot, randomUUID()));
  // Lets sweepStale tell live sessions from crashed ones (a dir's mtime is not updated by nested writes).
  await writeFile(join(tracesDir, "pid"), String(process.pid), { mode: 0o600 });
  const browser = await chromium.launch({ headless, tracesDir }).catch(async (err: unknown) => {
    await rm(tracesDir, { recursive: true, force: true });
    throw err;
  });
  const context = await browser.newContext({
    storageState: profile ? profilePath(profile) : undefined,
  });
  return {
    browser,
    context,
    async close() {
      await browser.close().catch(() => {});
      await rm(tracesDir, { recursive: true, force: true });
    },
  };
}

const STALE_NO_PID_MS = 24 * 60 * 60 * 1000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH"; // EPERM: alive, owned by someone else
  }
}

/**
 * Removes raw trace dirs left behind by crashed sessions: the owning pid (from the `pid` file) is no
 * longer alive, or, with no readable pid file, the dir is older than 24 hours.
 */
async function sweepStale(root: string): Promise<void> {
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const dir = join(root, name);
    const pid = Number.parseInt(await readFile(join(dir, "pid"), "utf8").catch(() => ""), 10);
    if (Number.isInteger(pid) && pid > 0) {
      if (!isAlive(pid)) await rm(dir, { recursive: true, force: true });
      continue;
    }
    const info = await stat(dir).catch(() => undefined);
    if (info && info.mtimeMs < Date.now() - STALE_NO_PID_MS) await rm(dir, { recursive: true, force: true });
  }
}
