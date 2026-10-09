import type { Browser, BrowserContext } from "playwright";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOUND_HOME, REPO_ROOT, ensurePrivateDir } from "./paths.ts";
import { HoundError } from "./errors.ts";
import { hasProfile, profilePath } from "./profiles.ts";

export interface SessionOptions {
  /** Saved login to load. Omit for anonymous browsing. */
  profile?: string;
  headless?: boolean;
  /** Private directory for downloads started by the page (default: a Playwright temp dir). It is emptied and removed on close. */
  downloadsPath?: string;
  /** Viewport of every page (default: Playwright's 1280x720). */
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  /** Mobile emulation: isMobile + hasTouch. */
  mobile?: boolean;
  /** BCP 47 tag for navigator.language, Accept-Language and Intl. */
  locale?: string;
  /** IANA time zone name. */
  timezoneId?: string;
  /** Fixed position for navigator.geolocation; the geolocation permission is granted for the whole context. */
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  /** Service workers are not allowed: their requests bypass context routes (needed by `--block`). */
  blockServiceWorkers?: boolean;
}

export interface Session {
  browser: Browser;
  context: BrowserContext;
  close(): Promise<void>;
}

/** Does this Playwright launch failure mean the Chromium download is missing? */
export const isMissingBrowser = (message: string): boolean => /Executable doesn't exist|playwright install/i.test(message);

export function missingBrowserError(): HoundError {
  return new HoundError("BROWSER_CRASHED", "Chromium is not installed for Playwright; install it once, then retry.", {
    retryable: false,
    suggestedFix: `pnpm --dir ${REPO_ROOT} browsers`,
  });
}

export const defaultHeadless = (): boolean => process.env.HOUND_HEADLESS !== "false";

export async function openSession({ profile, headless = defaultHeadless(), downloadsPath, viewport, deviceScaleFactor, mobile, locale, timezoneId, geolocation, blockServiceWorkers }: SessionOptions = {}): Promise<Session> {
  if (profile && !hasProfile(profile)) {
    throw new HoundError("PROFILE_NOT_FOUND", `Profile "${profile}" not found.`, {
      field: "profile",
      received: profile,
      suggestedFix: `hound profile login --profile ${profile} --url <url> --json`,
    });
  }
  // Raw trace chunks go to a private per-session dir (never the system temp dir), removed on close.
  const tracesRoot = await ensurePrivateDir(join(HOUND_HOME, "tmp", "traces"));
  await sweepStale(tracesRoot);
  const tracesDir = await ensurePrivateDir(join(tracesRoot, randomUUID()));
  // Lets sweepStale tell live sessions from crashed ones (a dir's mtime is not updated by nested writes).
  await writeFile(join(tracesDir, "pid"), String(process.pid), { mode: 0o600 });
  // Loaded on demand: importing playwright costs ~200 ms, which commands that never open a browser should not pay.
  const { chromium } = await import("playwright");
  if (downloadsPath) await ensurePrivateDir(downloadsPath);
  const browser = await chromium.launch({ headless, tracesDir, ...(downloadsPath ? { downloadsPath } : {}) }).catch(async (err: unknown) => {
    await rm(tracesDir, { recursive: true, force: true });
    if (downloadsPath) await rm(downloadsPath, { recursive: true, force: true });
    if (isMissingBrowser(err instanceof Error ? err.message : String(err))) throw missingBrowserError();
    throw err;
  });
  const context = await browser.newContext({
    storageState: profile ? profilePath(profile) : undefined,
    ...(viewport ? { viewport } : {}),
    ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    ...(locale ? { locale } : {}),
    ...(timezoneId ? { timezoneId } : {}),
    ...(geolocation ? { geolocation, permissions: ["geolocation"] } : {}),
    ...(blockServiceWorkers ? { serviceWorkers: "block" as const } : {}),
  });
  return {
    browser,
    context,
    async close() {
      await browser.close().catch(() => {});
      await rm(tracesDir, { recursive: true, force: true });
      if (downloadsPath) await rm(downloadsPath, { recursive: true, force: true });
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
