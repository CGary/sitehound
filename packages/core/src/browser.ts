import { chromium, type Browser, type BrowserContext } from "playwright";
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
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    storageState: profile ? profilePath(profile) : undefined,
  });
  return { browser, context, close: () => browser.close() };
}
