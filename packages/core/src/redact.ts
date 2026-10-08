/** Longest string any helper here runs a regex over; longer input is cut with a marker. */
const MAX_INPUT = 100_000;
const CUT_MARKER = "…[truncated]";
const TOKEN = "[token]";

const JWT_RE = /eyJ[\w-]{5,2000}\.[\w-]{1,2000}\.[\w-]{0,2000}/g;
const BEARER_RE = /\bBearer\s{1,8}[\w\-.~+/=]{1,4096}/gi;
const LONG_RUN_RE = /[A-Za-z0-9_\-+/=]{24,}/g;

/**
 * Replaces credential-looking strings with "[token]": JWTs, `Bearer <x>`, and any run of 24+
 * characters of [A-Za-z0-9_-+/=] that mixes letters and digits. Normal words and short ids stay.
 */
export function scrubTokens(text: string): string {
  const s = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) + CUT_MARKER : text;
  return s
    .replace(JWT_RE, TOKEN)
    .replace(BEARER_RE, TOKEN)
    .replace(LONG_RUN_RE, (run) => (/[A-Za-z]/.test(run) && /\d/.test(run) ? TOKEN : run));
}

const TOKEN_SEGMENT_RE = /^[A-Za-z0-9_\-+=]{24,}$/;

/** Is this URL path segment a credential-like id (24+ letters-and-digits run, or 32+ characters)? */
function isTokenSegment(seg: string): boolean {
  if (seg.length >= 32) return true;
  return TOKEN_SEGMENT_RE.test(seg) && /[A-Za-z]/.test(seg) && /\d/.test(seg);
}

/** Replaces token-like path segments with ":token". Works on absolute paths and relative URLs. */
export function stripPathTokens(path: string): string {
  return path
    .split("/")
    .map((seg) => (isTokenSegment(seg) ? ":token" : seg))
    .join("/");
}

/** Keeps origin + pathname only (query, fragment and credentials dropped; token-like path segments masked). */
export function stripUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin + stripPathTokens(u.pathname) : u.protocol;
  } catch {
    return "[invalid-url]";
  }
}

const DATA_URL_RE = /\bdata:([\w.+-]{1,60}\/[\w.+-]{1,60})(?:;[\w=.+-]{1,60}){0,4},[^\s"'<>)]*/gi;

/** Strips query/fragment from every URL inside free text, absolute or relative. Input is capped first. */
function stripUrlsIn(text: string): string {
  const s = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) + CUT_MARKER : text;
  return s
    .replace(DATA_URL_RE, "data:$1,…")
    .replace(/https?:\/\/[^\s"'<>)]+/g, (m) => stripUrl(m))
    .replace(/((?:href|src|action|url)\s{0,8}[=(]\s{0,8}["']?[^\s"'<>?#)]{0,2048})[?#][^\s"'<>)]*/gi, "$1");
}

/** Strips query/fragment from every URL inside free text, masks tokens, and truncates it. */
export function redactText(text: string, max = 500): string {
  const clean = scrubTokens(stripUrlsIn(text));
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Deep copy of a JSON-like value with URLs in every string stripped of query/fragment. */
export function redactData(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return stripUrlsIn(value);
  if (depth > 20 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactData(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactData(v, depth + 1)]));
}
