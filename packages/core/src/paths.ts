import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Root for all runtime data (profiles, runs). Git-ignored. */
export const HOUND_HOME = resolve(process.env.HOUND_HOME ?? ".hound");
export const PROFILES_DIR = join(HOUND_HOME, "profiles");
export const RUNS_DIR = join(HOUND_HOME, "runs");

/**
 * Creates a private directory (0700) under HOUND_HOME. The root gets its own
 * `.gitignore` with `*`, so its contents stay out of git even if HOUND_HOME is
 * pointed somewhere the repo's .gitignore does not cover.
 */
export async function ensurePrivateDir(dir: string): Promise<string> {
  await mkdir(HOUND_HOME, { recursive: true, mode: 0o700 });
  await writeFile(join(HOUND_HOME, ".gitignore"), "*\n", { flag: "w" });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Rejects names that could escape their directory (`../`, `/`, etc.). */
export function assertSafeName(kind: string, name: string): void {
  if (!SAFE_NAME.test(name) || name.includes("..")) {
    throw new Error(`Invalid ${kind} name "${name}". Use letters, digits, ".", "_" or "-".`);
  }
}
