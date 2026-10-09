/**
 * `browser open --block`: which requests a session refuses. The host lists hold only well-known tracking and advertising
 * services (a host matches itself and its subdomains); `images`, `media` and `fonts` are decided by the resource type the
 * browser reports. Dependency-free, so the matcher can be unit-tested without a browser.
 */
import type { BlockCategory } from "./limits.ts";

interface HostRule {
  host: string;
  /** Only URLs whose path is this or below it (e.g. the Facebook pixel lives at /tr). */
  pathPrefix?: string;
}

const h = (host: string, pathPrefix?: string): HostRule => (pathPrefix ? { host, pathPrefix } : { host });

/** Web analytics, session replay and product-analytics collectors. */
export const ANALYTICS_HOSTS: readonly HostRule[] = [
  h("google-analytics.com"), h("analytics.google.com"), h("googletagmanager.com"), h("stats.g.doubleclick.net"),
  h("connect.facebook.net"), h("www.facebook.com", "/tr"), h("analytics.tiktok.com"),
  h("hotjar.com"), h("hotjar.io"),
  h("cdn.segment.com"), h("api.segment.io"), h("segment.io"),
  h("api.mixpanel.com"), h("api-js.mixpanel.com"), h("cdn.mxpnl.com"), h("mxpnl.com"),
  h("api.amplitude.com"), h("api2.amplitude.com"), h("cdn.amplitude.com"),
  h("clarity.ms"), h("bat.bing.com"), h("px.ads.linkedin.com"), h("snap.licdn.com"), h("analytics.twitter.com"), h("scorecardresearch.com"),
];

/** Ad networks and ad servers. */
export const AD_HOSTS: readonly HostRule[] = [
  h("doubleclick.net"), h("googlesyndication.com"), h("googleadservices.com"), h("googletagservices.com"), h("adservice.google.com"),
  h("2mdn.net"), h("adnxs.com"), h("adsrvr.org"), h("criteo.com"), h("criteo.net"), h("taboola.com"), h("outbrain.com"),
  h("amazon-adsystem.com"), h("pubmatic.com"), h("rubiconproject.com"), h("openx.net"), h("casalemedia.com"), h("moatads.com"), h("static.ads-twitter.com"),
];

/** Resource types (as Playwright reports them) refused by the type categories. */
const RESOURCE_TYPES: Partial<Record<BlockCategory, readonly string[]>> = {
  images: ["image"],
  media: ["media"],
  fonts: ["font"],
};

function hostMatches(rules: readonly HostRule[], hostname: string, pathname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return rules.some((r) => {
    if (host !== r.host && !host.endsWith(`.${r.host}`)) return false;
    return !r.pathPrefix || pathname === r.pathPrefix || pathname.startsWith(`${r.pathPrefix}/`);
  });
}

/** The first of `categories` (catalog order) that says this request must be refused, or undefined to let it through. */
export function blockedCategory(url: string, resourceType: string, categories: readonly BlockCategory[]): BlockCategory | undefined {
  let u: URL | undefined;
  for (const c of categories) {
    const types = RESOURCE_TYPES[c];
    if (types) {
      if (types.includes(resourceType)) return c;
      continue;
    }
    u ??= (() => {
      try {
        return new URL(url);
      } catch {
        return undefined;
      }
    })();
    if (!u) continue;
    if (hostMatches(c === "analytics" ? ANALYTICS_HOSTS : AD_HOSTS, u.hostname, u.pathname)) return c;
  }
  return undefined;
}
