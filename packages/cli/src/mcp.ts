import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createRunDir, defaultHeadless, hasProfile, profilePath } from "@sitehound/core";

export interface McpOptions {
  /** Saved login to preload (in memory only; the profile file is never modified). */
  profile?: string;
  headed: boolean;
  /** Extra flags forwarded verbatim to the @playwright/mcp server. */
  extraArgs: string[];
}

/**
 * Run the official Playwright MCP server (stdio) preloaded with a sitehound profile.
 * stdout belongs to the MCP protocol: this module writes only to stderr.
 */
export async function runMcp({ profile, headed, extraArgs }: McpOptions): Promise<void> {
  if (profile && !hasProfile(profile)) {
    throw new Error(`Profile "${profile}" not found. Create it with: pnpm hound login <url> --profile ${profile}`);
  }

  const cliEntry = fileURLToPath(import.meta.resolve("@playwright/mcp/package.json")).replace(/package\.json$/, "cli.js");
  const outDir = await createRunDir("mcp");

  const args = [cliEntry, "--output-dir", outDir];
  // @playwright/mcp bundles its own playwright build whose Chromium revision may differ from the one
  // installed by `pnpm browsers`, so point it at the Chromium that the repo's playwright installed.
  args.push("--executable-path", chromium.executablePath());
  if (!headed && defaultHeadless()) args.push("--headless");
  if (profile) args.push("--isolated", "--storage-state", profilePath(profile));
  else args.push("--isolated");
  args.push(...extraArgs);

  process.stderr.write(`sitehound mcp: output dir ${outDir}${profile ? `, profile "${profile}"` : ""}\n`);

  const child = spawn(process.execPath, args, { stdio: "inherit" });
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (c, signal) => resolve(c ?? (signal ? 128 + (signal === "SIGINT" ? 2 : 15) : 1)));
  });
  process.off("SIGINT", onInt);
  process.off("SIGTERM", onTerm);
  process.exit(code);
}
