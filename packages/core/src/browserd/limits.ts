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

/** `element drag`: how the pointer travels (auto = HTML5 drag-and-drop first, a real pointer path when the page did not react) and the number of pointer moves of that path. */
export const DRAG_METHODS = ["auto", "html5", "mouse"] as const;
export const DRAG_STEPS_MIN = 1;
export const DRAG_STEPS_MAX = 50;
export const DRAG_STEPS_DEFAULT = 10;
/** `element drag --method auto`: how long (ms) to wait for any sign that dragTo worked before repeating with the pointer path. */
export const DRAG_SETTLE_MS = 1000;

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

/** `page snapshot --diff`: most snapshot texts kept per tab (one per ref/depth combination, oldest dropped) and the largest text kept as a baseline. */
export const SNAPSHOT_BASELINES_PER_TAB = 8;
export const SNAPSHOT_BASELINE_MAX_CHARS = 1_000_000;
/** Unchanged lines shown around each changed hunk of a snapshot diff. */
export const SNAPSHOT_DIFF_CONTEXT = 1;

/** `browser open --block`: the request categories that can be blocked, and the shape of the comma list (no duplicates check; they are merged). */
export const BLOCK_CATEGORIES = ["analytics", "ads", "images", "media", "fonts"] as const;
export type BlockCategory = (typeof BLOCK_CATEGORIES)[number];
const BLOCK_ALT = BLOCK_CATEGORIES.join("|");
export const BLOCK_PATTERN = `^(?:${BLOCK_ALT})(?:,(?:${BLOCK_ALT}))*$`;

/** Parses a validated `--block` list into unique categories in catalog order; undefined when an entry is unknown. */
export function parseBlockList(text: string): BlockCategory[] | undefined {
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length === 0 || !parts.every((p): p is BlockCategory => (BLOCK_CATEGORIES as readonly string[]).includes(p))) return undefined;
  return BLOCK_CATEGORIES.filter((c) => parts.includes(c));
}

/** `browser open --locale/--timezone/--geolocation`: shapes (declared as patterns on the flags) and the checks the patterns cannot do. */
export const LOCALE_PATTERN = "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$";
export const TIMEZONE_PATTERN = "^[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+){0,2}$";
export const GEOLOCATION_PATTERN = "^-?[0-9]{1,3}(?:\\.[0-9]{1,8})?,-?[0-9]{1,3}(?:\\.[0-9]{1,8})?(?:,[0-9]{1,6}(?:\\.[0-9]{1,3})?)?$";
export const GEOLOCATION_ACCURACY_MAX = 100_000;
export const GEOLOCATION_RANGE = `latitude -90..90, longitude -180..180, accuracy 0..${GEOLOCATION_ACCURACY_MAX} meters`;

export interface Geolocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

export const geolocationInBounds = (g: unknown): g is Geolocation => {
  if (typeof g !== "object" || g === null) return false;
  const { latitude, longitude, accuracy } = g as Record<string, unknown>;
  return (
    typeof latitude === "number" && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    typeof longitude === "number" && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 &&
    (accuracy === undefined || (typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= GEOLOCATION_ACCURACY_MAX))
  );
};

/** Parses "lat,lon[,accuracy]" within the bounds; undefined when the shape or a bound is wrong. */
export function parseGeolocation(text: string): Geolocation | undefined {
  if (!new RegExp(GEOLOCATION_PATTERN).test(text)) return undefined;
  const [lat, lon, acc] = text.split(",").map(Number) as [number, number, number | undefined];
  const g: Geolocation = { latitude: lat, longitude: lon, ...(acc !== undefined ? { accuracy: acc } : {}) };
  return geolocationInBounds(g) ? g : undefined;
}

/** Is this a BCP 47 language tag the runtime knows how to canonicalize? */
export function isValidLocale(text: unknown): boolean {
  if (typeof text !== "string" || !new RegExp(LOCALE_PATTERN).test(text)) return false;
  try {
    return Intl.getCanonicalLocales(text).length === 1;
  } catch {
    return false;
  }
}

/** Is this an IANA time zone name the runtime knows (checked with Intl)? */
export function isValidTimezone(text: unknown): boolean {
  if (typeof text !== "string" || text.length > 64 || !new RegExp(TIMEZONE_PATTERN).test(text)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: text });
    return true;
  } catch {
    return false;
  }
}

/** `page pdf`: paper sizes. */
export const PDF_FORMATS = ["A4", "Letter", "Legal"] as const;
export type PdfFormat = (typeof PDF_FORMATS)[number];

/** Successful actions a session keeps for `script export` (in memory only; the oldest are dropped). */
export const ACTION_LOG_CAP = 500;
/** Longest time spent describing one element (stable locator) before an action; the action itself never waits longer. */
export const RECORD_DESCRIBE_MS = 500;

/** `batch`: steps per call (max) and the default of --max-steps. */
export const BATCH_MAX_STEPS = 200;
export const BATCH_DEFAULT_MAX_STEPS = 50;
/** `batch`: largest steps file (characters) and the inline JSON budget of all step `data` together. */
export const BATCH_FILE_MAX_CHARS = 1_000_000;
export const BATCH_OUTPUT_MAX_CHARS = 100_000;
