import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HoundError } from "./errors.ts";

/** Repository root, derived from this file's location (packages/core/src), never from the cwd. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// `<repo>/.env` may set HOUND_HOME (and other HOUND_* switches). Load it before HOUND_HOME is computed.
// process.loadEnvFile never overrides variables that are already set, so the real environment wins.
try {
  process.loadEnvFile(join(REPO_ROOT, ".env"));
} catch {
  // no .env (or unreadable): nothing to load
}

/**
 * Root for all runtime data (profiles, runs, sessions). Git-ignored. Defaults to `<repo>/.hound`;
 * `HOUND_HOME` overrides it, and a relative value resolves against the repo root (not the cwd).
 */
export const HOUND_HOME = process.env.HOUND_HOME
  ? isAbsolute(process.env.HOUND_HOME)
    ? resolve(process.env.HOUND_HOME)
    : resolve(REPO_ROOT, process.env.HOUND_HOME)
  : join(REPO_ROOT, ".hound");
export const PROFILES_DIR = join(HOUND_HOME, "profiles");
export const RUNS_DIR = join(HOUND_HOME, "runs");
export const SESSIONS_DIR = join(HOUND_HOME, "sessions");

/**
 * Creates a private directory (0700) under HOUND_HOME. The root gets its own
 * `.gitignore` with `*`, so its contents stay out of git even if HOUND_HOME is
 * pointed somewhere the repo's .gitignore does not cover.
 */
export async function ensurePrivateDir(dir: string): Promise<string> {
  await mkdir(HOUND_HOME, { recursive: true, mode: 0o700 });
  await ensureGitignore(join(HOUND_HOME, ".gitignore"));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Creates the ignore file with `*` if missing; appends `*` if no line equals it; never overwrites. */
async function ensureGitignore(path: string): Promise<void> {
  try {
    await writeFile(path, "*\n", { flag: "wx", mode: 0o600 });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const text = await readFile(path, "utf8");
  if (text.split(/\r?\n/).some((line) => line.trim() === "*")) return;
  await appendFile(path, text === "" || text.endsWith("\n") ? "*\n" : "\n*\n");
}

export const SAFE_NAME_RULE = "1-64 chars, letters/digits/._-, must start with a letter or digit";

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Rejects names that could escape their directory (`../`, `/`, etc.). */
export function assertSafeName(kind: string, name: string): void {
  if (!SAFE_NAME.test(name) || name.includes("..")) {
    throw new HoundError("INVALID_ARGUMENT", `Invalid ${kind} name "${name}": ${SAFE_NAME_RULE}.`, {
      field: kind,
      received: name,
    });
  }
}
