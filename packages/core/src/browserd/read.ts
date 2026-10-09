/** Safety rules and redaction for `element read`. */
import { HoundError } from "../errors.ts";
import { HINT_RE } from "../trace.ts";
import { redactText, scrubTokens, stripPathTokens, stripUrl } from "../redact.ts";

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
  return redactText(value, Number.MAX_SAFE_INTEGER);
}

/** Strips the query and fragment from the `- /url: ...` lines of an aria snapshot; refs and structure are untouched. */
export function sanitizeSnapshot(text: string): string {
  return text.replace(/^(\s*- \/url: )(.+)$/gm, (_m, pre: string, v: string) => {
    const q = /^(["'])(.*)\1$/.exec(v);
    return q ? `${pre}${q[1]}${redactUrlAttr(q[2]!)}${q[1]}` : `${pre}${redactUrlAttr(v)}`;
  });
}
