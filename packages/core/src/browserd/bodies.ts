/**
 * Pure helpers for the request/body and download ops: filename sanitizing and the redaction of
 * request/response bodies. Nothing here touches the browser or the disk, so it is unit-testable.
 *
 * Bodies are redacted BEFORE they are returned or written: secret-looking keys lose their values
 * (in JSON, forms, XML/HTML, and `key=value` / `key: value` text of any kind), remaining strings go
 * through URL stripping, secret-pair scrubbing, token scrubbing and card-number masking, and binary
 * content is never returned. Headers are never read into any result.
 */
import { redactText, scrubTokens } from "../redact.ts";

const REDACTED = "[redacted]";
const MAX_DEPTH = 30;
const MAX_FORM_PAIRS = 2000;
const MAX_MULTIPART_PARTS = 200;
/** A non-file multipart field shows its value only up to this size. */
const MULTIPART_VALUE_MAX = 2000;
/** redactText/scrubTokens cap their input at 100 000 characters; text is processed in pieces below that so nothing is cut silently. */
const CHUNK = 90_000;

// ---- filenames ----

export const DOWNLOAD_FALLBACK_NAME = "download.bin";
const MAX_FILENAME = 120;
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g;

/**
 * A safe file name from a page-controlled `suggestedFilename()`: tokens and e-mail addresses masked, no path parts, no
 * control or bidi characters, no leading dots, at most 120 characters (extension kept), `download.bin` when nothing is left.
 */
export function sanitizeFilename(raw: string): string {
  const last = raw.slice(0, 2000).split(/[\\/]/).pop() ?? "";
  // The extension is kept out of the masking (an e-mail pattern could otherwise swallow it).
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(last)?.[0] ?? "";
  let name = (scrubTokens(last.slice(0, last.length - ext.length).replace(EMAIL_RE, "[email]")) + ext)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (name.length > MAX_FILENAME) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, MAX_FILENAME - ext.length) + ext;
  }
  // File systems cap a name at 255 BYTES; stay well under it for multi-byte characters.
  while (Buffer.byteLength(name) > 200) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, Math.max(1, name.length - ext.length - 10)) + ext;
  }
  return name === "" ? DOWNLOAD_FALLBACK_NAME : name;
}

/** `report.pdf` + 2 -> `report-2.pdf` (extension kept). */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

// ---- secret keys ----

const SECRET_WORDS = new Set([
  "pass", "passwd", "pwd", "pw", "pword", "pswd", "psw", "password", "passcode", "passphrase", "secret", "token", "auth", "authorization", "authentication",
  "session", "sid", "sessid", "cookie", "credential", "credentials", "csrf", "xsrf", "otp", "pin", "cvv", "cvc", "ssn", "signature", "jwt", "bearer", "apikey", "pan",
]);
const SECRET_FRAGMENTS = [
  "password", "passwd", "passw", "secret", "token", "apikey", "credential", "authoriz", "authentic", "csrf", "xsrf", "cookie", "session", "sessid",
  "privatekey", "accesskey", "cardnumber", "cardnum", "creditcard", "ccnumber", "cardno",
];

/** Does this key name look like it holds a secret? Word-based, so `shipping` and `author` are not secrets but `userPassword`, `access_token`, `X-CSRF`, `PHPSESSID`, `pw` and `pin` are. */
export function isSecretKey(key: string): boolean {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const words = spaced.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => SECRET_WORDS.has(w))) return true;
  const joined = words.join("");
  return SECRET_FRAGMENTS.some((f) => joined.includes(f));
}

/** `{ "name": "password", "value": "x" }` (serializeArray, legacy forms): the sibling value of a secret NAME is secret. */
const NAME_KEYS = new Set(["name", "key", "field", "fieldname", "field_name", "id", "param", "attr", "attribute"]);
const VALUE_KEYS = new Set(["value", "val", "v", "values"]);
const CARD_PARENT_RE = /card|^cc|payment|credit/i;
const CARD_FIELDS = new Set(["number", "num", "no", "pan", "code"]);
/** A key or parent key that says its string values are card data. */
const isCardKey = (key: string): boolean => CARD_PARENT_RE.test(key) || /(?:^|[^a-z])(?:pan|tarjeta)(?:[^a-z]|$)/i.test(key);

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const PAN_RE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
/** Digit groups typical of cards, one separator kind throughout: 4-4-4-(1..7) (13-19 digits), Amex 4-6-5, Diners 4-6-4. */
const PAN_GROUPED_RE = /^(?:\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}|\d{4}([ -])\d{6}\2\d{4,5})$/;
/**
 * Issuer table for numbers without a card context or card-like grouping: IIN prefix and the lengths that brand uses.
 * Visa 4 (13, 16, 19); Mastercard 51-55 and 2221-2720 (16); Amex 34/37 (15); Discover 6011, 644-649, 65 (16-19); Diners 30[0-5], 3095, 36, 38, 39 (14);
 * JCB 35 (16-19); UnionPay 62 (16-19); Mir 2200-2204 (16-19); Maestro and other 50, 56-69 (13-19).
 * Numbers that start with anything else (epoch milliseconds start with 1) are never masked on shape alone.
 */
const PAN_BRANDS: ReadonlyArray<{ prefix: RegExp; lengths: readonly number[] }> = [
  { prefix: /^4/, lengths: [13, 16, 19] },
  { prefix: /^(?:5[1-5]|2(?:22[1-9]|2[3-9]\d|[3-6]\d{2}|7[01]\d|720))/, lengths: [16] },
  { prefix: /^3[47]/, lengths: [15] },
  { prefix: /^(?:6011|64[4-9]|65)/, lengths: [16, 17, 18, 19] },
  { prefix: /^(?:30[0-5]|3095|3[689])/, lengths: [14] },
  { prefix: /^35/, lengths: [16, 17, 18, 19] },
  { prefix: /^62/, lengths: [16, 17, 18, 19] },
  { prefix: /^220[0-4]/, lengths: [16, 17, 18, 19] },
  { prefix: /^(?:50|5[6-9]|6\d)/, lengths: [13, 14, 15, 16, 17, 18, 19] },
];
const knownBrand = (digits: string): boolean => PAN_BRANDS.some((b) => b.prefix.test(digits) && b.lengths.includes(digits.length));
/** Words just before a number that say it is a card number (the lookback is one line, 40 characters). */
const PAN_BEFORE_RE = /(?<![a-z])(?:card|cc|pan|tarjeta|credit|debit|visa|mastercard|amex)(?![a-z])[^\d\n]{0,40}$/i;

/** Does this digit run pass Luhn AND look like a card (hint, card-like grouping, or a known issuer prefix at that brand's length)? */
function looksLikePan(raw: string, digits: string, hinted: boolean): boolean {
  if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return false;
  return hinted || PAN_GROUPED_RE.test(raw) || knownBrand(digits);
}

/**
 * Masks card numbers: 13-19 digits (single spaces or dashes allowed between groups) that pass the Luhn check AND are card-like:
 * the caller says the text is a card field (`cardContext`: key or parent such as `card.number`), or a card word precedes the
 * number, or the digits are grouped like a card (4-4-4-4, 4-6-5), or they start with an issuer prefix at that brand's length
 * (see PAN_BRANDS: Visa, Mastercard, Amex, Discover, Diners, JCB, UnionPay, Mir, Maestro). Other long numbers that happen to pass Luhn (epoch milliseconds, ids) are kept.
 */
export function maskPans(text: string, cardContext = false): string {
  return text.replace(PAN_RE, (m, offset: number) => {
    const digits = m.replace(/[ -]/g, "");
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const before = text.slice(Math.max(lineStart, offset - 60), offset);
    return looksLikePan(m, digits, cardContext || PAN_BEFORE_RE.test(before)) ? "[pan]" : m;
  });
}

// ---- free text: `key=value`, `key: value`, JS/GraphQL literals, XML, HTML ----

const ASSIGN_RE_SOURCE = String.raw`(?<![\w.-])([A-Za-z_][\w.-]{0,59})(\\?["']?)\s{0,8}[:=]\s{0,8}`;

/** End of the value starting at `i` and what to put in its place; undefined when there is no value. */
function valueSpan(text: string, i: number): { end: number; repl: string } | undefined {
  const c = text[i];
  if (c === undefined) return undefined;
  if (c === "\\" && (text[i + 1] === '"' || text[i + 1] === "'")) {
    // A value inside an escaped JSON string: \"4711\"
    const q = text[i + 1]!;
    const close = text.indexOf(`\\${q}`, i + 2);
    return { end: close === -1 ? text.length : close + 2, repl: `\\${q}${REDACTED}\\${q}` };
  }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < text.length) {
      const ch = text[j];
      if (ch === "\\") j += 2;
      else if (ch === c) return { end: j + 1, repl: `${c}${REDACTED}${c}` };
      else if (ch === "\n") break;
      else j++;
    }
    return { end: Math.min(j, text.length), repl: `${c}${REDACTED}${c}` };
  }
  if (c === "{" || c === "[") {
    // A whole object/array under a secret key, up to its balanced close (or the end of a cut-off text).
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (ch === '"') {
        j++;
        while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      } else if (ch === "{" || ch === "[") depth++;
      else if ((ch === "}" || ch === "]") && --depth === 0) return { end: j + 1, repl: `"${REDACTED}"` };
    }
    return { end: text.length, repl: `"${REDACTED}"` };
  }
  let j = i;
  const scheme = /^(?:bearer|basic|digest|negotiate|token)\s{1,8}/i.exec(text.slice(i, i + 20));
  if (scheme) j += scheme[0].length;
  while (j < text.length && !/[\s,;&}\])"'<>]/.test(text[j]!)) j++;
  return j > i ? { end: j, repl: REDACTED } : undefined;
}

/** Replaces the value after every secret-looking `key:` / `key=` (quoted, escaped, bare, balanced objects, cut-off text). */
function scrubAssignments(text: string): string {
  if (!/[:=]/.test(text)) return text;
  const re = new RegExp(ASSIGN_RE_SOURCE, "g");
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!isSecretKey(m[1]!)) continue;
    const start = m.index + m[0].length;
    const span = valueSpan(text, start);
    if (!span) continue;
    out += text.slice(last, start) + span.repl;
    last = span.end;
    re.lastIndex = span.end;
  }
  return out + text.slice(last);
}

const XML_ELEMENT_RE = /<([A-Za-z_][\w:.-]{0,60})(\s[^<>]{0,500})?>([^<]{1,4096})<\/\1\s*>/g;
const TAG_RE = /<[A-Za-z][^<>]{0,2000}>/g;
const ATTR_NAME_RE = /\b(?:name|id)\s*=\s*(?:"([^"]{1,100})"|'([^']{1,100})')/i;
const ATTR_VALUE_RE = /(\bvalue\s*=\s*)(?:"[^"]*"|'[^']*')/i;

/** `<password>x</password>` and `<input name="csrf_token" value="x">`. */
function scrubMarkup(text: string): string {
  if (!text.includes("<")) return text;
  return text
    .replace(XML_ELEMENT_RE, (m: string, tag: string, attrs: string | undefined, content: string) => (isSecretKey(tag) ? `<${tag}${attrs ?? ""}>${REDACTED}</${tag}>` : m))
    .replace(TAG_RE, (tag: string) => {
      const name = ATTR_NAME_RE.exec(tag);
      return name && isSecretKey(name[1] ?? name[2] ?? "") ? tag.replace(ATTR_VALUE_RE, `$1"${REDACTED}"`) : tag;
    });
}

/** Splits long text into pieces under the regex helpers' input cap, preferably between token-like runs. */
function inChunks(text: string, fn: (piece: string) => string): string {
  if (text.length <= CHUNK) return fn(text);
  const parts: string[] = [];
  for (let pos = 0; pos < text.length; ) {
    let end = Math.min(text.length, pos + CHUNK);
    if (end < text.length) {
      for (let k = end; k > end - 2000; k--) {
        if (!/[A-Za-z0-9_\-+/=]/.test(text[k - 1]!)) {
          end = k;
          break;
        }
      }
    }
    parts.push(fn(text.slice(pos, end)));
    pos = end;
  }
  return parts.join("");
}

/** Free-text redaction: secret assignments and markup first, then URLs, secret pairs, tokens and card numbers. Never cuts the text. */
function redactPlain(text: string, cardContext = false): string {
  const marked = scrubMarkup(scrubAssignments(text));
  return inChunks(marked, (piece) => maskPans(redactText(piece, Number.POSITIVE_INFINITY), cardContext));
}

const looksJson = (s: string): boolean => {
  const t = s.trimStart();
  return t.startsWith("{") || t.startsWith("[");
};

/** One string value (or key): a JSON document inside a string is parsed and redacted structurally; anything else as free text. */
function cleanString(s: string, depth: number, cardContext = false): string {
  if (depth < MAX_DEPTH && looksJson(s)) {
    try {
      return JSON.stringify(redactJsonValue(JSON.parse(s), depth + 1));
    } catch {
      // not JSON: free text below
    }
  }
  return redactPlain(s, cardContext);
}

const cleanKey = (k: string): string => {
  const c = redactPlain(k);
  return c.length > 200 ? `${c.slice(0, 200)}…` : c;
};

function redactJsonValue(value: unknown, depth: number, parentKey = "", inCard = false): unknown {
  if (typeof value === "string") return cleanString(value, depth, inCard || isCardKey(parentKey));
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redactJsonValue(v, depth + 1, parentKey, inCard));
  const entries = Object.entries(value);
  const secretName = entries.some(([k, v]) => NAME_KEYS.has(k.toLowerCase()) && typeof v === "string" && isSecretKey(v));
  const cardContext = CARD_PARENT_RE.test(parentKey);
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    const lower = k.toLowerCase();
    const secret = isSecretKey(k) || (secretName && VALUE_KEYS.has(lower)) || (cardContext && CARD_FIELDS.has(lower));
    out[cleanKey(k)] = secret ? REDACTED : redactJsonValue(v, depth + 1, k, inCard || isCardKey(parentKey));
  }
  return out;
}

// ---- content classification ----

/** The bare media type of a Content-Type header (lowercase, no parameters), or "" when absent or malformed. */
export function mediaType(header: string | undefined): string {
  const t = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][\w.+-]{0,60}\/[\w.+*-]{1,80}$/.test(t) ? t : "";
}

function boundaryOf(header: string | undefined): string | undefined {
  const m = /boundary\s*=\s*(?:"([^"]{1,200})"|([^;\s]{1,200}))/i.exec(header ?? "");
  return m?.[1] ?? m?.[2];
}

const TEXT_TYPE = /^(?:text\/|application\/(?:json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|x-yaml|x-ndjson|xhtml\+xml|csv|x-javascript)|.+\+(?:json|xml)$)/;

/** True when a Content-Type is present and is neither text-like nor multipart (so it can be skipped unread). */
export function isBinaryType(header: string | undefined): boolean {
  const type = mediaType(header);
  return type !== "" && !type.startsWith("multipart/") && !TEXT_TYPE.test(type);
}

/**
 * Decodes a text body honoring a BOM or the declared charset (UTF-16 included). Returns undefined when the charset is unknown
 * or the result contains NUL characters (binary, or text in an encoding we cannot trust): the caller then treats it as binary.
 */
function decodeText(buf: Buffer, header: string | undefined): string | undefined {
  let label = (/charset\s*=\s*"?([\w.:-]{1,40})/i.exec(header ?? "")?.[1] ?? "utf-8").toLowerCase();
  let start = 0;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    label = "utf-8";
    start = 3;
  } else if (buf[0] === 0xff && buf[1] === 0xfe) {
    label = "utf-16le";
    start = 2;
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    label = "utf-16be";
    start = 2;
  }
  if (label === "utf-16") label = "utf-16le";
  let text: string;
  try {
    text = new TextDecoder(label).decode(buf.subarray(start));
  } catch {
    return undefined;
  }
  return text.includes("\u0000") ? undefined : text;
}

function looksLikeText(buf: Buffer): boolean {
  const head = buf.subarray(0, 2048);
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return true;
  if (head.includes(0)) return false;
  // One replacement character is tolerated: the 2048-byte cut may split a multi-byte character.
  return (head.toString("utf8").match(/\ufffd/g)?.length ?? 0) <= 1;
}

export type BodyFormat = "json" | "form" | "multipart" | "text" | "binary";

export interface RedactedBody {
  format: BodyFormat;
  /** The redacted text; absent for binary content. */
  text?: string;
}

function redactForm(raw: string): RedactedBody {
  if (looksJson(raw)) {
    // A JSON document posted as a form (e.g. jQuery with JSON.stringify): it is one "key"; redact it structurally.
    try {
      return { format: "form", text: JSON.stringify(redactJsonValue(JSON.parse(raw), 0)) };
    } catch {
      return { format: "form", text: redactPlain(raw) };
    }
  }
  const pairs = [...new URLSearchParams(raw)].slice(0, MAX_FORM_PAIRS);
  const secretName = pairs.some(([k, v]) => NAME_KEYS.has(k.toLowerCase()) && isSecretKey(v));
  const lines = pairs.map(([k, v]) => {
    const secret = isSecretKey(k) || (secretName && VALUE_KEYS.has(k.toLowerCase()));
    return `${cleanKey(k)}=${secret ? REDACTED : cleanString(v, 0, isCardKey(k))}`;
  });
  if (new URLSearchParams(raw).size > MAX_FORM_PAIRS) lines.push("[more fields omitted]");
  return { format: "form", text: lines.join("\n") };
}

/** Multipart: names and sizes; file parts never show a value; small non-file text fields show a redacted value. */
function redactMultipart(buf: Buffer, boundary: string): string {
  const raw = buf.toString("latin1");
  const chunks = raw.split(`--${boundary}`).slice(1);
  const lines: string[] = [];
  let n = 0;
  for (const chunk of chunks) {
    if (chunk.startsWith("--")) break;
    if (++n > MAX_MULTIPART_PARTS) {
      lines.push("[more parts omitted]");
      break;
    }
    const sep = chunk.indexOf("\r\n\r\n");
    if (sep === -1) continue;
    const head = chunk.slice(0, sep);
    let body = chunk.slice(sep + 4);
    if (body.endsWith("\r\n")) body = body.slice(0, -2);
    const name = /\bname="([^"]{0,200})"/i.exec(head)?.[1] ?? "";
    const isFile = /\bfilename\*?=/i.test(head);
    const partType = /^content-type:\s*([^\r\n;]+)/im.exec(head)?.[1]?.trim().toLowerCase() ?? "";
    const decodedName = Buffer.from(name, "latin1").toString("utf8");
    const label = cleanKey(decodedName || "(unnamed)").slice(0, 80);
    const size = body.length;
    if (isFile || (partType !== "" && !TEXT_TYPE.test(partType)) || size > MULTIPART_VALUE_MAX || body.includes("\u0000")) {
      lines.push(`${label}: ${isFile ? "file, " : ""}${size} bytes`);
      continue;
    }
    const value = isSecretKey(decodedName) ? REDACTED : cleanString(Buffer.from(body, "latin1").toString("utf8"), 0, isCardKey(decodedName));
    lines.push(`${label}: ${size} bytes, value ${JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

/**
 * Redacts a body for return. `contentType` is the raw Content-Type header (its media type, charset and multipart
 * boundary are used). Binary or non-text content yields `{ format: "binary" }` with no text. The text is never cut.
 */
export function redactBody(buf: Buffer, contentType: string | undefined): RedactedBody {
  const type = mediaType(contentType);
  const multipart = type.startsWith("multipart/");
  const text = type === "" ? looksLikeText(buf) : multipart || TEXT_TYPE.test(type);
  if (!text) return { format: "binary" };
  if (multipart) {
    const boundary = boundaryOf(contentType);
    return boundary ? { format: "multipart", text: redactMultipart(buf, boundary) } : { format: "binary" };
  }
  const raw = decodeText(buf, contentType);
  if (raw === undefined) return { format: "binary" };
  if (type === "application/x-www-form-urlencoded") return redactForm(raw);
  if (type.includes("json") || ((type === "" || type.startsWith("text/")) && looksJson(raw))) {
    try {
      return { format: "json", text: JSON.stringify(redactJsonValue(JSON.parse(raw), 0)) };
    } catch {
      // not valid JSON (cut off, ndjson, JSONP): free-text redaction below
    }
  }
  return { format: "text", text: redactPlain(raw) };
}
