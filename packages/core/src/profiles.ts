import { chmod, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { HoundError } from "./errors.ts";
import { PROFILES_DIR, assertSafeName, ensurePrivateDir } from "./paths.ts";
import { stripUrl } from "./redact.ts";

/** Non-secret facts about one saved login (a profile can hold several sites). */
export interface ProfileSite {
  loginUrl: string;
  landingUrl: string;
  savedAt: string;
}

/** Non-secret facts about a saved profile, used to detect an expired session. */
export interface ProfileMeta {
  name: string;
  sites: ProfileSite[];
}

/** How a login is stored: `replace` starts a fresh profile, `extend` adds a site to an existing one. */
export type LoginMode = "replace" | "extend";

/** A profile is a saved, reusable login: cookies, localStorage and IndexedDB. */
export function profilePath(name: string): string {
  assertSafeName("profile", name);
  if (name.endsWith(".meta")) {
    throw new HoundError("INVALID_ARGUMENT", `Invalid profile name "${name}": must not end in ".meta".`, { field: "profile", received: name });
  }
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

export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** The site whose landing origin matches `url`, else the first site. */
export function pickSite(meta: ProfileMeta | undefined, url?: string): ProfileSite | undefined {
  if (!meta || meta.sites.length === 0) return undefined;
  const origin = url ? originOf(url) : undefined;
  return meta.sites.find((s) => originOf(s.landingUrl) === origin) ?? meta.sites[0];
}

/**
 * Saves `<name>.meta.json` next to the profile. URLs are stored without query/fragment.
 * `extend` appends the site, or updates the existing entry with the same login origin;
 * `replace` (default) keeps only this site.
 */
export async function saveProfileMeta(name: string, loginUrl: string, landingUrl: string, mode: LoginMode = "replace"): Promise<ProfileMeta> {
  profilePath(name);
  const site: ProfileSite = {
    loginUrl: stripUrl(loginUrl),
    landingUrl: stripUrl(landingUrl),
    savedAt: new Date().toISOString(),
  };
  const sites = mode === "extend" ? (readProfileMeta(name)?.sites ?? []) : [];
  const origin = originOf(site.loginUrl);
  const at = sites.findIndex((s) => originOf(s.loginUrl) === origin);
  if (at === -1) sites.push(site);
  else sites[at] = site;
  const meta: ProfileMeta = { name, sites };
  await ensurePrivateDir(PROFILES_DIR);
  await writeFile(profileMetaPath(name), JSON.stringify(meta, null, 2), { mode: 0o600 });
  await chmod(profileMetaPath(name), 0o600);
  return meta;
}

/**
 * Returns undefined when the profile predates meta files or the file is unreadable.
 * Reads both the current `{ name, sites }` format and the old single-site one.
 */
export function readProfileMeta(name: string): ProfileMeta | undefined {
  profilePath(name);
  try {
    const raw = JSON.parse(readFileSync(profileMetaPath(name), "utf8")) as {
      sites?: Partial<ProfileSite>[];
      loginUrl?: unknown;
      landingUrl?: unknown;
      savedAt?: unknown;
    };
    const candidates: Partial<ProfileSite>[] = Array.isArray(raw.sites) ? raw.sites : [raw as Partial<ProfileSite>];
    const sites: ProfileSite[] = [];
    for (const c of candidates) {
      if (typeof c?.loginUrl !== "string" || typeof c.landingUrl !== "string") continue;
      sites.push({ loginUrl: c.loginUrl, landingUrl: c.landingUrl, savedAt: String(c.savedAt ?? "") });
    }
    return sites.length ? { name, sites } : undefined;
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
