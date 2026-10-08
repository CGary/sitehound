import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { profilePath, type ProfileMeta } from "./profiles.ts";

export interface SessionCheck {
  state: "valid" | "expired" | "unknown";
  reason: string;
}

const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|auth|oauth2?|sso|session\/new)(\/|\.|$)/i;

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * Heuristic session check on the page's current state (it does not navigate).
 * To verify a stored session, navigate to `meta.landingUrl` first.
 */
export async function checkSession(page: Page, meta?: ProfileMeta): Promise<SessionCheck> {
  try {
    const cur = parse(page.url());
    if (!cur || (cur.protocol !== "http:" && cur.protocol !== "https:")) {
      return { state: "unknown", reason: "page is not on an http(s) URL" };
    }
    if (await page.locator("input[type=password]:visible").count()) {
      return { state: "expired", reason: "a password field is visible (login form)" };
    }
    const login = meta && parse(meta.loginUrl);
    const landing = meta && parse(meta.landingUrl);
    if (login && landing) {
      if (login.pathname !== landing.pathname && cur.origin === login.origin && cur.pathname === login.pathname) {
        return { state: "expired", reason: "redirected to the login URL" };
      }
      if (LOGIN_PATH.test(cur.pathname) && !LOGIN_PATH.test(landing.pathname)) {
        return { state: "expired", reason: "URL path looks like a login/auth page" };
      }
      if (cur.origin === landing.origin) return { state: "valid", reason: "on the landing origin, no login indicators" };
      return { state: "unknown", reason: "page left the landing origin" };
    }
    return { state: "unknown", reason: meta ? "profile meta is incomplete" : "no profile meta; no login indicators found" };
  } catch {
    return { state: "unknown", reason: "could not inspect the page" };
  }
}

export interface CookieStats {
  totalCookies: number;
  expiredCookies: number;
}

/** Counts cookies in a saved profile that are already past `expires`. Never exposes names or values. */
export function profileCookieStats(name: string): CookieStats {
  try {
    const state = JSON.parse(readFileSync(profilePath(name), "utf8")) as { cookies?: { expires?: number }[] };
    const cookies = Array.isArray(state.cookies) ? state.cookies : [];
    const now = Date.now() / 1000;
    const expired = cookies.filter((c) => typeof c.expires === "number" && c.expires > 0 && c.expires < now);
    return { totalCookies: cookies.length, expiredCookies: expired.length };
  } catch {
    return { totalCookies: 0, expiredCookies: 0 };
  }
}
