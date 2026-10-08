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
