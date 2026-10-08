import { chmod, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { PROFILES_DIR, assertSafeName, ensurePrivateDir } from "./paths.ts";

/** A profile is a saved, reusable login: cookies, localStorage and IndexedDB. */
export function profilePath(name: string): string {
  assertSafeName("profile", name);
  return join(PROFILES_DIR, `${name}.json`);
}

export function hasProfile(name: string): boolean {
  return existsSync(profilePath(name));
}

export async function saveProfile(context: BrowserContext, name: string): Promise<string> {
  const path = profilePath(name);
  await ensurePrivateDir(PROFILES_DIR);
  await context.storageState({ path, indexedDB: true });
  await chmod(path, 0o600);
  return path;
}

export async function listProfiles(): Promise<string[]> {
  if (!existsSync(PROFILES_DIR)) return [];
  const files = await readdir(PROFILES_DIR);
  return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
}

export async function deleteProfile(name: string): Promise<void> {
  await rm(profilePath(name), { force: true });
}
