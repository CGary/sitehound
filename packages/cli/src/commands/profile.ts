import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { HoundError } from "@sitehound/core/errors";
import { PROFILES_DIR } from "@sitehound/core/paths";
import { deleteProfile, hasProfile, listProfiles, originOf, profileMetaPath, profilePath, readProfileMeta } from "@sitehound/core/profiles";
import { defineCommand } from "../framework/types.ts";
import { NAME_RULE, houndCmd, parseUrlFlag, shellQuote } from "./shared.ts";

const notFound = (profile: string) =>
  new HoundError("PROFILE_NOT_FOUND", `Profile "${profile}" not found.`, {
    field: "profile",
    received: profile,
    suggestedFix: houndCmd("profile", "login", "--profile", profile, "--url", "<url>"),
  });

export const profileList = defineCommand({
  name: "profile.list",
  description: "List saved profiles (names and site origins only, never credentials).",
  kind: "read",
  flags: {},
  examples: ["hound profile list --json", "hound profile list --plain", "hound profile list --json --quiet"],
  async run() {
    const names = await listProfiles();
    const profiles = names.map((name) => {
      const meta = readProfileMeta(name);
      return { name, sites: (meta?.sites ?? []).map((s) => ({ origin: originOf(s.landingUrl) ?? s.landingUrl, savedAt: s.savedAt })) };
    });
    const first = profiles[0];
    return {
      summary: profiles.length ? `${profiles.length} profile(s) saved.` : "No profiles saved.",
      data: { count: profiles.length, profiles },
      plain: profiles.length ? profiles.map((p) => `${p.name}  ${p.sites.map((s) => s.origin).join(" ")}`).join("\n") : "No profiles saved.",
      next_actions: first
        ? [{ command: houndCmd("profile", "check", "--profile", first.name), reason: "Verify the saved session is still valid." }]
        : [{ command: houndCmd("profile", "login", "--profile", "<profile>", "--url", "<url>"), reason: "A human must log in once to create a profile (replace <profile> and <url>)." }],
    };
  },
});

type State = "valid" | "expired" | "unknown";
const SEVERITY: Record<State, number> = { valid: 0, unknown: 1, expired: 2 };

export const profileCheck = defineCommand({
  name: "profile.check",
  description: "Check whether a saved login is still valid (navigates to each saved site). State is data, exit is 0.",
  kind: "read",
  flags: {
    profile: { type: "string", required: true, ...NAME_RULE, description: "Profile name" },
    site: { type: "string", description: "Only check this origin, e.g. https://example.com" },
  },
  examples: ["hound profile check --profile work --json", "hound profile check --profile work --site https://example.com --json", "hound profile check --profile work --plain"],
  timeoutSeconds: 120,
  async run(input, ctx) {
    const profile: string = input.profile;
    if (!hasProfile(profile)) throw notFound(profile);
    const { openSession, checkSession, profileCookieStats } = await import("@sitehound/core");
    const meta = readProfileMeta(profile);
    let sites = meta?.sites ?? [];
    if (input.site !== undefined) {
      const want = originOf(input.site) ?? input.site;
      const picked = sites.filter((s) => originOf(s.landingUrl) === want);
      if (!picked.length) {
        const origins = sites.map((s) => originOf(s.landingUrl) ?? s.landingUrl);
        throw new HoundError("INVALID_ARGUMENT", `Profile "${profile}" has no site ${want}.`, {
          field: "site",
          received: want,
          allowed: origins,
          retryable: true,
          suggestedFix: origins[0] ? houndCmd("profile", "check", "--profile", profile, "--site", origins[0]) : houndCmd("profile", "check", "--profile", profile),
        });
      }
      sites = picked;
    }
    const cookies = profileCookieStats(profile);
    const results: { origin: string; landingUrl: string; state: State; reason: string }[] = [];
    if (sites.length) {
      const session = await openSession({ profile });
      try {
        const page = await session.context.newPage();
        for (const site of sites) {
          ctx.log(`checking ${originOf(site.landingUrl) ?? site.landingUrl}`);
          await page.goto(site.landingUrl, { waitUntil: "load", timeout: 30_000 }).catch(() => {});
          const { state, reason } = await checkSession(page, site);
          results.push({ origin: originOf(site.landingUrl) ?? site.landingUrl, landingUrl: site.landingUrl, state, reason });
        }
      } finally {
        await session.close();
      }
    }
    const worst = results.reduce<{ state: State; reason: string } | undefined>(
      (acc, r) => (!acc || SEVERITY[r.state] > SEVERITY[acc.state] ? { state: r.state, reason: r.reason } : acc),
      undefined,
    ) ?? { state: "unknown" as State, reason: "profile has no saved site info; log in again to record it" };
    const data = {
      profile,
      state: worst.state,
      reason: worst.reason,
      cookies: { total: cookies.totalCookies, expired: cookies.expiredCookies },
      sites: results,
    };
    const loginUrl = results.find((r) => r.state === "expired")?.landingUrl ?? sites[0]?.landingUrl ?? "<url>";
    return {
      summary: `Profile "${profile}" is ${worst.state}: ${worst.reason}`,
      data,
      next_actions:
        worst.state === "valid"
          ? [{ command: houndCmd("task", "run", "--task", "snapshot", "--url", loginUrl, "--profile", profile), reason: "Capture a page with this session." }]
          : [{ command: houndCmd("profile", "login", "--profile", profile, "--url", loginUrl, "--mode", "extend"), reason: "A human must log in again in a terminal; agents cannot." }],
    };
  },
});

export const profileLogin = defineCommand({
  name: "profile.login",
  description: "HUMAN ONLY: log in by hand in a browser window and save the session as a profile (needs a TTY).",
  kind: "write",
  flags: {
    profile: { type: "string", required: true, ...NAME_RULE, description: "Profile name to create or update" },
    url: { type: "string", required: true, maxLength: 2048, description: "Login page URL" },
    mode: { type: "enum", values: ["replace", "extend"], default: "replace", description: "replace starts empty (discards the old sites); extend keeps the existing profile's sites and adds this one. Required explicitly when the profile already exists" },
  },
  examples: [
    "hound profile login --profile work --url https://example.com/login",
    "hound profile login --profile work --url https://other.example.org/signin --mode extend",
    "hound profile login --profile work --url https://example.com/login --mode replace",
  ],
  async run(input, ctx) {
    const profile: string = input.profile;
    const mode: "replace" | "extend" = input.mode;
    const url = parseUrlFlag("url", input.url).href;
    profilePath(profile); // validates the name
    const exists = hasProfile(profile);
    if (exists && !ctx.given.has("mode")) {
      const extend = houndCmd("profile", "login", "--profile", profile, "--url", input.url, "--mode", "extend");
      const replace = houndCmd("profile", "login", "--profile", profile, "--url", input.url, "--mode", "replace");
      throw new HoundError(
        "CONFIRMATION_REQUIRED",
        `Profile "${profile}" already exists. --mode extend keeps its saved sites and adds this one; --mode replace discards them and starts empty. Choose one explicitly.`,
        { field: "mode", allowed: ["extend", "replace"], retryable: true, suggestedFix: extend, data: { alternatives: [extend, replace] } },
      );
    }
    if (!ctx.interactive) {
      throw new HoundError(
        "NO_TTY",
        `A human must run this in a terminal: hound profile login --profile ${shellQuote(profile)} --url ${shellQuote(input.url)}`,
        { retryable: false },
      );
    }
    if (mode === "extend" && !exists) {
      throw new HoundError("PROFILE_NOT_FOUND", `Cannot extend: profile "${profile}" does not exist.`, {
        field: "profile",
        received: profile,
        suggestedFix: houndCmd("profile", "login", "--profile", profile, "--url", input.url, "--mode", "replace"),
      });
    }
    const { openSession, saveProfile, saveProfileMeta } = await import("@sitehound/core");
    const session = await openSession({ profile: mode === "extend" ? profile : undefined, headless: false });
    try {
      const page = await session.context.newPage();
      await page.goto(url).catch((err: unknown) => {
        throw new HoundError("NAVIGATION_FAILED", `Could not open the login page: ${err instanceof Error ? err.message.split("\n")[0] : "navigation error"}`, { field: "url" });
      });
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        await rl.question("Log in in the browser window, then press Enter here to save the session… ", { signal: ctx.signal });
      } finally {
        rl.close();
      }
      const landingUrl = page.url();
      const path = await saveProfile(session.context, profile);
      const meta = await saveProfileMeta(profile, url, landingUrl, mode);
      return {
        summary: `Profile "${profile}" saved (${mode}); ${meta.sites.length} site(s).`,
        data: { profile, mode, path, sites: meta.sites.map((s) => ({ origin: originOf(s.landingUrl) ?? s.landingUrl, savedAt: s.savedAt })) },
        plain: `Profile "${profile}" saved (${path}). Keep it private: it grants access to your account.`,
        next_actions: [{ command: houndCmd("profile", "check", "--profile", profile), reason: "Confirm the saved session works." }],
      };
    } finally {
      await session.close();
    }
  },
});

export const profileDelete = defineCommand({
  name: "profile.delete",
  description: "Delete a saved profile. Needs --dry-run (preview) or --yes (confirm).",
  kind: "write",
  flags: {
    profile: { type: "string", required: true, ...NAME_RULE, description: "Profile name" },
    "dry-run": { type: "boolean", description: "Only report what would be deleted" },
    yes: { type: "boolean", description: "Confirm the deletion" },
  },
  confirm: [{ oneOf: ["dry-run", "yes"], message: "Deleting a profile is irreversible: pass --dry-run to preview or --yes to confirm." }],
  examples: ["hound profile delete --profile work --dry-run --json", "hound profile delete --profile work --yes --json", "hound profile list --json"],
  async run(input) {
    const profile: string = input.profile;
    if (!hasProfile(profile)) throw notFound(profile);
    const files = [profilePath(profile), profileMetaPath(profile)];
    const present = files.filter((f) => existsSync(f));
    if (input["dry-run"]) {
      return {
        summary: `Would delete profile "${profile}" (${present.length} file(s)).`,
        data: { profile, dry_run: true, would_delete: present, dir: PROFILES_DIR },
        next_actions: [{ command: houndCmd("profile", "delete", "--profile", profile, "--yes"), reason: "Delete it for real." }],
      };
    }
    await deleteProfile(profile);
    return { summary: `Profile "${profile}" deleted.`, data: { profile, dry_run: false, deleted: present } };
  },
});

export const profileCommands = [profileList, profileCheck, profileLogin, profileDelete];
