/**
 * Stable error contract shared by core and the CLI. The CLI maps a HoundError to its JSON
 * error envelope: { ok: false, command, error: { code, message, field?, received?, allowed? },
 * retryable, suggested_fix?: { command } }. Codes are part of the public contract: never rename.
 */
export const ERROR_CODES = [
  // usage (exit 2)
  "UNKNOWN_COMMAND",
  "INVALID_ARGUMENT",
  "MISSING_REQUIRED_FLAG",
  "INVALID_ENUM",
  "CONFIRMATION_REQUIRED",
  // environment / state (exit 1)
  "FILE_NOT_FOUND",
  "CONFIG_NOT_FOUND",
  "PROFILE_NOT_FOUND",
  "TASK_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "SESSION_EXISTS",
  "REF_NOT_FOUND",
  "ACTION_BLOCKED",
  "NO_TTY",
  "NAVIGATION_FAILED",
  "BROWSER_CRASHED",
  "RUN_FAILED",
  "RUN_ERROR",
  "VALIDATION_FAILED",
  "PERMISSION_DENIED",
  "CONFLICT",
  "TIMEOUT",
  "NETWORK_ERROR",
  "PARTIAL_SUCCESS",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const USAGE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  "UNKNOWN_COMMAND",
  "INVALID_ARGUMENT",
  "MISSING_REQUIRED_FLAG",
  "INVALID_ENUM",
  "CONFIRMATION_REQUIRED",
]);

export interface HoundErrorDetails {
  field?: string;
  received?: unknown;
  allowed?: readonly string[];
  retryable?: boolean;
  /** A complete corrected command the agent can run next. */
  suggestedFix?: string;
  /** Extra structured data (e.g. a run result) to include in the envelope's `data`. */
  data?: unknown;
}

export class HoundError extends Error {
  readonly code: ErrorCode;
  readonly details: HoundErrorDetails;

  constructor(code: ErrorCode, message: string, details: HoundErrorDetails = {}) {
    super(message);
    this.name = "HoundError";
    this.code = code;
    this.details = details;
  }

  /** Plain JSON form, used to cross process boundaries (browser session daemon <-> CLI). */
  toJSON(): { code: ErrorCode; message: string; details: HoundErrorDetails } {
    return { code: this.code, message: this.message, details: this.details };
  }

  static fromJSON(value: { code: ErrorCode; message: string; details?: HoundErrorDetails }): HoundError {
    return new HoundError(value.code, value.message, value.details ?? {});
  }
}

export const isHoundError = (err: unknown): err is HoundError => err instanceof HoundError;
