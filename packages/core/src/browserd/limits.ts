/**
 * Limits shared by the CLI (declared in --schema, checked before any work) and the daemon (checked again).
 * Dependency-free so the CLI can import it without loading the browser code.
 */

/** Longest value `element type` accepts, in characters. */
export const TYPE_MAX_CHARS = 5000;
/** Number of recent requests the daemon keeps for `diag request` (matches the 500-entry `network` list). */
export const REQUEST_BUFFER_CAP = 500;
/** Longest time one daemon op may take. */
export const MAX_OP_TIMEOUT_MS = 600_000;
/** `element type`: fixed part of its time budget, and the extra cost per key on top of --delay-ms (dispatch overhead). */
export const TYPING_BASE_MS = 10_000;
export const TYPING_EXTRA_MS_PER_KEY = 5;

/** Time budget for typing `chars` characters with `delayMs` between keys (never past the op limit). */
export const typingTimeoutMs = (chars: number, delayMs: number): number =>
  Math.min(MAX_OP_TIMEOUT_MS, TYPING_BASE_MS + chars * (delayMs + TYPING_EXTRA_MS_PER_KEY));

/** Does typing fit inside one op? */
export const typingFits = (chars: number, delayMs: number): boolean => TYPING_BASE_MS + chars * (delayMs + TYPING_EXTRA_MS_PER_KEY) <= MAX_OP_TIMEOUT_MS;

/** `element upload`: most files per call, and the cap on their total size. */
export const UPLOAD_MAX_FILES = 20;
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** Longest dialog answer (`--dialog-text`) in characters, and how many handled dialogs a session keeps. */
export const DIALOG_TEXT_MAX_CHARS = 1000;
export const DIALOG_BUFFER_CAP = 100;
/** How long (ms) an op's explicit --dialog override keeps applying to dialogs raised after the op returned (timers, requests it started). */
export const DIALOG_GRACE_MS = 2000;

/** Viewport bounds (CSS pixels) for `browser open --viewport` and `page resize`, and the device scale factor range. */
export const VIEWPORT_MIN_WIDTH = 200;
export const VIEWPORT_MAX_WIDTH = 7680;
export const VIEWPORT_MIN_HEIGHT = 200;
export const VIEWPORT_MAX_HEIGHT = 4320;
export const DEVICE_SCALE_FACTOR_MIN = 1;
export const DEVICE_SCALE_FACTOR_MAX = 4;
/** The shape of a `--viewport` value; the bounds are checked by `parseViewport`. */
export const VIEWPORT_PATTERN = "^[0-9]{3,4}x[0-9]{3,4}$";

/** Parses "375x812" within the bounds; undefined when the shape or a bound is wrong. */
export function parseViewport(text: string): { width: number; height: number } | undefined {
  const m = /^([0-9]{3,4})x([0-9]{3,4})$/i.exec(text);
  if (!m) return undefined;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return viewportInBounds(width, height) ? { width, height } : undefined;
}

export const viewportInBounds = (width: unknown, height: unknown): boolean =>
  typeof width === "number" && typeof height === "number" && Number.isInteger(width) && Number.isInteger(height) &&
  width >= VIEWPORT_MIN_WIDTH && width <= VIEWPORT_MAX_WIDTH && height >= VIEWPORT_MIN_HEIGHT && height <= VIEWPORT_MAX_HEIGHT;

/** `page find`: longest pattern, longest line examined, most characters of snapshot scanned, and the match/context ranges. */
export const FIND_PATTERN_MAX_CHARS = 200;
export const FIND_LINE_MAX_CHARS = 2000;
export const FIND_SNAPSHOT_MAX_CHARS = 2_000_000;
export const FIND_LIMIT_MAX = 200;
export const FIND_LIMIT_DEFAULT = 30;
export const FIND_CONTEXT_MAX = 3;
/** Wall-clock budget of a `page find --regex` scan before it is cancelled as too slow. */
export const FIND_REGEX_BUDGET_MS = 2000;

/** `element read`: the --limit-chars range, and the most characters read from the page for one element. */
export const READ_LIMIT_DEFAULT = 2000;
export const READ_LIMIT_MAX = 20_000;
export const READ_SCAN_MAX_CHARS = 100_000;
/** A valid HTML attribute name, as accepted by `element read --attr`. */
export const ATTR_NAME_PATTERN = "^[a-zA-Z_:][-a-zA-Z0-9_:.]{0,63}$";
