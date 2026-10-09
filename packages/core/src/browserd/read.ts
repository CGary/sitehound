/** Safety rules and redaction for `element read`. */
import { HoundError } from "../errors.ts";
import { HINT_RE } from "../trace.ts";
import { redactText, scrubTokens, stripPathTokens, stripUrl } from "../redact.ts";
import { maskPans } from "./bodies.ts";

/** Source and flags of the trace cleaner's "this field holds a secret" hint (password, otp, cvv, card, csrf, token, pin, ...). */
export const SENSITIVE_HINT = { source: HINT_RE.source, flags: HINT_RE.flags };

/** Attributes that may be read on a password or other sensitive field: they describe the field, never its content. */
export const PASSWORD_SAFE_ATTRS: readonly string[] = [
  "type", "name", "id", "placeholder", "autocomplete", "required", "disabled", "readonly", "maxlength", "minlength", "aria-label", "aria-required", "aria-invalid",
];

/** Attribute names that hold a URL: query and fragment are always removed. */
export const isUrlAttr = (name: string): boolean => /^(?:href|src|action|formaction|srcset|poster|data-[a-z0-9_.:-]*url[a-z0-9_.:-]*)$/i.test(name);

/** What the page tells us about the element, collected in the page (serializable). */
export interface ReadFacts {
  tag: string;
  /** A password, hidden, one-time-code, card, CSRF-like or otherwise secret-looking form field. */
  sensitive: boolean;
  /** Attribute value (`value` on a form field = its live value), or null when absent. Only set when an attribute was asked for. */
  attr: string | null;
  /** innerText, only when no attribute was asked for. */
  text: string;
  /**
   * Words that describe the element and its surroundings (name, id, aria-label, test id, placeholder, labels, the label just
   * before it, and the id/class/aria-label of up to three ancestors), collected in the page. Used only to decide how much of
   * a text to mask (see `redactReadText`), never returned.
   */
  hints?: string;
}

/** The ACTION_BLOCKED error for a password or other secret-looking field. */
export function passwordBlocked(ref: string, what: string): HoundError {
  return new HoundError("ACTION_BLOCKED", `Reading ${what} of a password, hidden or secret-looking field (card, OTP, CSRF, PIN, token) is blocked; only its descriptive attributes (${PASSWORD_SAFE_ATTRS.join(", ")}) can be read.`, {
    field: "ref",
    received: ref,
    retryable: false,
  });
}

/** Removes the query and fragment from a URL attribute value (absolute or relative) and masks credential-like parts. */
export function redactUrlAttr(value: string): string {
  const v = value.trim();
  if (/^https?:/i.test(v)) return scrubTokens(stripUrl(v));
  if (/^data:/i.test(v)) return redactText(v, 100);
  const cut = v.split(/[?#]/, 1)[0] ?? "";
  return scrubTokens(/^[a-z][a-z0-9+.-]*:/i.test(cut) ? cut : stripPathTokens(cut));
}

/** Redacts one attribute value: URL attributes lose query/fragment, everything gets tokens masked. */
export function redactAttr(name: string, value: string): string {
  if (isUrlAttr(name)) {
    // srcset holds several comma-separated candidates ("url 2x, url 1x").
    return name.toLowerCase() === "srcset" ? value.split(",").map((c) => { const [u = "", ...d] = c.trim().split(/\s+/); return [redactUrlAttr(u), ...d].join(" "); }).join(", ") : redactUrlAttr(value);
  }
  return maskPans(redactText(value, Number.MAX_SAFE_INTEGER));
}

/** Strips the query and fragment from the `- /url: ...` lines of an aria snapshot; refs and structure are untouched. */
export function sanitizeSnapshot(text: string): string {
  return text.replace(/^(\s*- \/url: )(.+)$/gm, (_m, pre: string, v: string) => {
    const q = /^(["'])(.*)\1$/.exec(v);
    return q ? `${pre}${q[1]}${redactUrlAttr(q[2]!)}${q[1]}` : `${pre}${redactUrlAttr(v)}`;
  });
}


// ---- value-shape redaction of plain text (element read, page find) ----

/** Words that say a number nearby is a one-time code, PIN or similar secret (English and Spanish). */
const OTP_WORDS_RE = /(?<![\p{L}\p{N}])(?:otp|totp|hotp|pin|passcode|verification|verificaci[o\u00f3]n|verify|code|codigo|c[o\u00f3]digo|clave|2fa|mfa|one[- ]?time|cvv|cvc|csc|security\s+code)(?![\p{L}\p{N}])/iu;
/** "zip code", "promo code", "error code" ...: a code, but not a secret one. */
const BENIGN_CODE_RE = /(?<![\p{L}\p{N}])(?:zip|postal|post|area|country|dial|promo(?:tion(?:al)?)?|coupon|discount|voucher|colou?r|bar|qr|source|error|status|product|item|html|css)[\s_-]*(?:code|codigo|c[o\u00f3]digo)/giu;
/** Standalone 4-8 digit numbers, or such a number split by spaces/dashes in groups of 2-4 ("482 913"). Not part of a longer number, date, time, decimal, amount or word; a short capital prefix with a dash ("G-482913", as Google sends codes) is allowed. */
const CODE_NUMBER_RE = /(?:(?<=(?<![\p{L}\p{N}])[A-Z]{1,3}-)|(?<![\p{L}\p{N}_.,:/$\u20ac\u00a3-]))\d{2,8}(?:[ -]\d{2,4}){0,3}(?![\p{L}\p{N}_%$\u20ac\u00a3]|[.,:/-]\d)/gu;

/** Does this text (labels, attributes, nearby words) say its numbers are secret codes? */
export function hintsOtp(text: string): boolean {
  return OTP_WORDS_RE.test(text.replace(BENIGN_CODE_RE, " "));
}

/** Does this text say its numbers are card data? */
const hintsCard = (text: string): boolean => /(?<![a-z])(?:card|cc|pan|tarjeta|credit|debit)(?![a-z])/i.test(text);

const maskCodes = (text: string): string =>
  text.replace(CODE_NUMBER_RE, (m) => {
    const digits = m.replace(/\D/g, "").length;
    if (/^\d{4}-\d{2}-\d{2}$/.test(m) || /^\d{2}-\d{2}-\d{4}$/.test(m)) return m;
    return digits >= 4 && digits <= 8 ? "[code]" : m;
  });

/**
 * Masks one-time-code-shaped numbers in `lines`. With `all` (the element itself is an OTP/code/PIN field or sits in one) every
 * standalone 4-8 digit number is masked; otherwise only the lines that mention a code word themselves or follow a label line that
 * does ("Verification code" above "482913"). Generic numbers (prices, dates, quantities) elsewhere are never touched.
 */
export function maskOtpLines(lines: readonly string[], all = false): string[] {
  let prevHint = false;
  return lines.map((line) => {
    const here = hintsOtp(line);
    const mask = all || here || prevHint;
    // Only a label ("Verification code": short, no number of its own) carries over to the next line; an empty line in between does not break it.
    if (line.trim() !== "") prevHint = here && line.length <= 100 && !/\d{3,}/.test(line.replace(/\[ref=[^\]]*\]/g, ""));
    return mask ? maskCodes(line) : line;
  });
}

/**
 * The text `element read` returns: tokens masked, one-time codes masked when the element or its surroundings (`hints`) or the
 * text itself says they are codes, and card numbers masked (Luhn plus card-like shape, or a card hint).
 */
export function redactReadText(text: string, hints = ""): string {
  const masked = maskOtpLines(scrubTokens(text).split("\n"), hintsOtp(hints)).join("\n");
  return maskPans(masked, hintsCard(hints));
}

/** Snapshot lines as `page find` returns them: codes after a code label and card numbers masked (matching is done on the raw lines). */
export function redactFindLines(lines: readonly string[]): string[] {
  return maskOtpLines(lines).map((l) => maskPans(l));
}
