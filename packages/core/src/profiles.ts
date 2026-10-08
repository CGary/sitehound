import { chmod, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { PROFILES_DIR, assertSafeName, ensurePrivateDir } from "./paths.ts";
import { stripUrl } from "./redact.ts";

/** Non-secret facts about a saved login, used to detect an expired session. */
export interface ProfileMeta {
  name: string;
  loginUrl: string;
  landingUrl: string;
  savedAt: string;
}

/** A profile is a saved, reusable login: cookies, localStorage and IndexedDB. */
export function profilePath(name: string): string {
  assertSafeName("profile", name);
  if (name.endsWith(".meta")) throw new Error(`Invalid profile name "${name}": must not end in ".meta".`);
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

export function profileMetaPath(name: string): string {
  return join(PROFILES_DIR, `${name}.meta.json`);
}

/** Saves `<name>.meta.json` next to the profile. URLs are stored without query/fragment. */
export async function saveProfileMeta(name: string, loginUrl: string, landingUrl: string): Promise<ProfileMeta> {
  profilePath(name);
  const meta: ProfileMeta = {
    name,
    loginUrl: stripUrl(loginUrl),
    landingUrl: stripUrl(landingUrl),
    savedAt: new Date().toISOString(),
  };
  await ensurePrivateDir(PROFILES_DIR);
  await writeFile(profileMetaPath(name), JSON.stringify(meta, null, 2), { mode: 0o600 });
  await chmod(profileMetaPath(name), 0o600);
  return meta;
}

/** Returns undefined when the profile predates meta files or the file is unreadable. */
export function readProfileMeta(name: string): ProfileMeta | undefined {
  profilePath(name);
  try {
    const meta = JSON.parse(readFileSync(profileMetaPath(name), "utf8")) as Partial<ProfileMeta>;
    if (typeof meta.loginUrl !== "string" || typeof meta.landingUrl !== "string") return undefined;
    return { name, loginUrl: meta.loginUrl, landingUrl: meta.landingUrl, savedAt: String(meta.savedAt ?? "") };
  } catch {
    return undefined;
  }
}

export async function listProfiles(): Promise<string[]> {
  if (!existsSync(PROFILES_DIR)) return [];
  const files = await readdir(PROFILES_DIR);
  return files.filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json")).map((f) => f.slice(0, -5));
}

export async function deleteProfile(name: string): Promise<void> {
  await rm(profilePath(name), { force: true });
  await rm(profileMetaPath(name), { force: true });
}
